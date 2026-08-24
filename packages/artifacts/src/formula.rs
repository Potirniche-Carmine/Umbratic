//! The formula surface: what may be written, and what it evaluates to.
//!
//! The allowlist and the evaluator are the same list. That is the whole design.
//! A general spreadsheet engine would have to be trusted on hundreds of
//! functions we never checked; here, a formula is either one this module can
//! evaluate — in which case its result is a fact we can report on — or it is
//! refused at create time with the cell that has to change. There is no third
//! category where we write a formula and hope.
//!
//! On an existing workbook the rule inverts: formulas already in a stranger's
//! file are left exactly as they are, and anything this module cannot evaluate
//! keeps the value Excel last cached for it. Writing a guessed number over
//! Excel's own cache would be the one unrecoverable mistake available here.

use std::collections::BTreeMap;

/// Every function a spec may write. Enforced by the schema and implemented
/// below; the two cannot drift because the check is a lookup in this table.
pub const ALLOWED_FUNCTIONS: &[&str] = &[
    "SUM",
    "SUMIF",
    "SUMIFS",
    "COUNT",
    "COUNTA",
    "COUNTIF",
    "COUNTIFS",
    "AVERAGE",
    "AVERAGEIF",
    "AVERAGEIFS",
    "MIN",
    "MAX",
    "ABS",
    "ROUND",
    "ROUNDUP",
    "ROUNDDOWN",
    "IF",
    "IFERROR",
    "IFNA",
    "AND",
    "OR",
    "NOT",
    "INDEX",
    "MATCH",
    "VLOOKUP",
    "HLOOKUP",
    "XLOOKUP",
    "TEXT",
    "LEFT",
    "RIGHT",
    "MID",
    "LEN",
    "TRIM",
    "CONCAT",
    "CONCATENATE",
    "TODAY",
    "DATE",
    "YEAR",
    "MONTH",
    "DAY",
    "EOMONTH",
    "N",
    "PMT",
    "FV",
    "PV",
    "RATE",
];

pub fn is_allowed(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ALLOWED_FUNCTIONS.contains(&upper.as_str())
}

/// A spreadsheet value, in the four shapes a cell can hold.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Number(f64),
    Text(String),
    Bool(bool),
    /// `#REF!`, `#DIV/0!`, and the rest. Carried rather than thrown so one bad
    /// cell does not stop the sheet from being evaluated.
    Error(&'static str),
    Empty,
}

impl Value {
    pub fn as_number(&self) -> Result<f64, &'static str> {
        match self {
            Self::Number(value) => Ok(*value),
            Self::Bool(value) => Ok(if *value { 1.0 } else { 0.0 }),
            Self::Empty => Ok(0.0),
            // Excel coerces a numeric string in arithmetic, and a workbook that
            // stores "1200" as text is common enough that refusing it would
            // produce a #VALUE! the user cannot explain.
            Self::Text(value) => value.trim().parse::<f64>().map_err(|_| "#VALUE!"),
            Self::Error(code) => Err(code),
        }
    }

    pub fn as_text(&self) -> Result<String, &'static str> {
        match self {
            Self::Text(value) => Ok(value.clone()),
            Self::Number(value) => Ok(format_number(*value)),
            Self::Bool(value) => Ok(if *value {
                "TRUE".into()
            } else {
                "FALSE".into()
            }),
            Self::Empty => Ok(String::new()),
            Self::Error(code) => Err(code),
        }
    }

    pub fn truthy(&self) -> Result<bool, &'static str> {
        match self {
            Self::Bool(value) => Ok(*value),
            Self::Number(value) => Ok(*value != 0.0),
            Self::Empty => Ok(false),
            Self::Text(value) => match value.to_ascii_uppercase().as_str() {
                "TRUE" => Ok(true),
                "FALSE" => Ok(false),
                _ => Err("#VALUE!"),
            },
            Self::Error(code) => Err(code),
        }
    }
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

/// One cell address, zero-based, with the sheet it belongs to.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct CellRef {
    pub sheet: Option<String>,
    pub row: u32,
    pub column: u32,
}

/// What the evaluator reads from. Implemented over whatever holds the sheet.
pub trait Sheet {
    fn value_at(&self, reference: &CellRef) -> Value;
    /// The formula in a cell, without its leading `=`.
    fn formula_at(&self, reference: &CellRef) -> Option<String>;
}

#[derive(Debug)]
pub enum ParseError {
    /// A function outside the allowlist. Named so the message can say which.
    NotAllowed(String),
    Syntax(String),
}

/* --------------------------------- parsing --------------------------------- */

#[derive(Clone, Debug)]
pub enum Expr {
    Number(f64),
    Text(String),
    Bool(bool),
    Ref(CellRef),
    Range(CellRef, CellRef),
    Call(String, Vec<Expr>),
    Unary(char, Box<Expr>),
    Binary(String, Box<Expr>, Box<Expr>),
}

pub fn parse(formula: &str) -> Result<Expr, ParseError> {
    let mut parser = Parser {
        chars: formula.chars().collect(),
        position: 0,
    };
    let expression = parser.expression()?;
    parser.skip_spaces();
    if parser.position < parser.chars.len() {
        return Err(ParseError::Syntax(format!(
            "unexpected '{}' at position {}",
            parser.chars[parser.position], parser.position
        )));
    }
    Ok(expression)
}

struct Parser {
    chars: Vec<char>,
    position: usize,
}

impl Parser {
    fn skip_spaces(&mut self) {
        while self.position < self.chars.len() && self.chars[self.position].is_whitespace() {
            self.position += 1;
        }
    }

    fn peek(&mut self) -> Option<char> {
        self.skip_spaces();
        self.chars.get(self.position).copied()
    }

    fn eat(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.position += 1;
            true
        } else {
            false
        }
    }

    fn expression(&mut self) -> Result<Expr, ParseError> {
        self.comparison()
    }

    fn comparison(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.concat()?;
        loop {
            self.skip_spaces();
            let operator = match self.chars.get(self.position) {
                Some('<') if self.chars.get(self.position + 1) == Some(&'=') => "<=",
                Some('<') if self.chars.get(self.position + 1) == Some(&'>') => "<>",
                Some('>') if self.chars.get(self.position + 1) == Some(&'=') => ">=",
                Some('<') => "<",
                Some('>') => ">",
                Some('=') => "=",
                _ => break,
            };
            self.position += operator.len();
            let right = self.concat()?;
            left = Expr::Binary(operator.to_owned(), Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn concat(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.additive()?;
        while self.peek() == Some('&') {
            self.position += 1;
            let right = self.additive()?;
            left = Expr::Binary("&".into(), Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn additive(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.multiplicative()?;
        loop {
            let operator = match self.peek() {
                Some('+') => '+',
                Some('-') => '-',
                _ => break,
            };
            self.position += 1;
            let right = self.multiplicative()?;
            left = Expr::Binary(operator.to_string(), Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn multiplicative(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.unary()?;
        loop {
            let operator = match self.peek() {
                Some('*') => '*',
                Some('/') => '/',
                Some('^') => '^',
                _ => break,
            };
            self.position += 1;
            let right = self.unary()?;
            left = Expr::Binary(operator.to_string(), Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr, ParseError> {
        match self.peek() {
            Some('-') => {
                self.position += 1;
                Ok(Expr::Unary('-', Box::new(self.unary()?)))
            }
            Some('+') => {
                self.position += 1;
                self.unary()
            }
            _ => self.postfix(),
        }
    }

    fn postfix(&mut self) -> Result<Expr, ParseError> {
        let mut value = self.primary()?;
        // Percent binds tighter than anything else and is the one postfix
        // operator a business formula actually uses.
        while self.peek() == Some('%') {
            self.position += 1;
            value = Expr::Binary("*".into(), Box::new(value), Box::new(Expr::Number(0.01)));
        }
        Ok(value)
    }

    fn primary(&mut self) -> Result<Expr, ParseError> {
        match self.peek() {
            None => Err(ParseError::Syntax("the formula ends early".into())),
            Some('(') => {
                self.position += 1;
                let inner = self.expression()?;
                if !self.eat(')') {
                    return Err(ParseError::Syntax("a bracket is not closed".into()));
                }
                Ok(inner)
            }
            Some('"') => {
                self.position += 1;
                let mut text = String::new();
                loop {
                    match self.chars.get(self.position) {
                        None => {
                            return Err(ParseError::Syntax("a quoted string is not closed".into()));
                        }
                        // Excel escapes a quote by doubling it.
                        Some('"') if self.chars.get(self.position + 1) == Some(&'"') => {
                            text.push('"');
                            self.position += 2;
                        }
                        Some('"') => {
                            self.position += 1;
                            break;
                        }
                        Some(character) => {
                            text.push(*character);
                            self.position += 1;
                        }
                    }
                }
                Ok(Expr::Text(text))
            }
            Some(character) if character.is_ascii_digit() || character == '.' => self.number(),
            Some(_) => self.name_or_reference(),
        }
    }

    fn number(&mut self) -> Result<Expr, ParseError> {
        let start = self.position;
        while self
            .chars
            .get(self.position)
            .is_some_and(|character| character.is_ascii_digit() || *character == '.')
        {
            self.position += 1;
        }
        // Scientific notation, which a percentage or a rate can produce.
        if self
            .chars
            .get(self.position)
            .is_some_and(|c| *c == 'e' || *c == 'E')
        {
            let mark = self.position;
            self.position += 1;
            if self
                .chars
                .get(self.position)
                .is_some_and(|c| *c == '+' || *c == '-')
            {
                self.position += 1;
            }
            if self
                .chars
                .get(self.position)
                .is_some_and(char::is_ascii_digit)
            {
                while self
                    .chars
                    .get(self.position)
                    .is_some_and(char::is_ascii_digit)
                {
                    self.position += 1;
                }
            } else {
                self.position = mark;
            }
        }
        let text: String = self.chars[start..self.position].iter().collect();
        text.parse::<f64>()
            .map(Expr::Number)
            .map_err(|_| ParseError::Syntax(format!("{text} is not a number")))
    }

    fn name_or_reference(&mut self) -> Result<Expr, ParseError> {
        let start = self.position;
        // A sheet-qualified reference may be quoted: 'Q3 Data'!B2.
        if self.chars.get(self.position) == Some(&'\'') {
            self.position += 1;
            while self.position < self.chars.len() && self.chars[self.position] != '\'' {
                self.position += 1;
            }
            self.position += 1;
        }
        while self.chars.get(self.position).is_some_and(|character| {
            character.is_alphanumeric()
                || *character == '_'
                || *character == '.'
                || *character == '$'
                || *character == '!'
        }) {
            self.position += 1;
        }
        let text: String = self.chars[start..self.position].iter().collect();
        if text.is_empty() {
            return Err(ParseError::Syntax(format!(
                "unexpected '{}'",
                self.chars.get(self.position).copied().unwrap_or(' ')
            )));
        }

        if self.peek() == Some('(') {
            self.position += 1;
            if !is_allowed(&text) {
                return Err(ParseError::NotAllowed(text.to_ascii_uppercase()));
            }
            let mut arguments = Vec::new();
            if self.peek() != Some(')') {
                loop {
                    arguments.push(self.expression()?);
                    if self.eat(',') {
                        continue;
                    }
                    break;
                }
            }
            if !self.eat(')') {
                return Err(ParseError::Syntax(format!("{text}( is not closed")));
            }
            return Ok(Expr::Call(text.to_ascii_uppercase(), arguments));
        }

        match text.to_ascii_uppercase().as_str() {
            "TRUE" => return Ok(Expr::Bool(true)),
            "FALSE" => return Ok(Expr::Bool(false)),
            _ => {}
        }

        let start_reference = parse_reference(&text)
            .ok_or_else(|| ParseError::Syntax(format!("{text} is not a cell reference")))?;
        if self.peek() == Some(':') {
            self.position += 1;
            let tail_start = self.position;
            while self
                .chars
                .get(self.position)
                .is_some_and(|character| character.is_alphanumeric() || *character == '$')
            {
                self.position += 1;
            }
            let tail: String = self.chars[tail_start..self.position].iter().collect();
            let mut end = parse_reference(&tail)
                .ok_or_else(|| ParseError::Syntax(format!("{tail} is not a cell reference")))?;
            // A range inherits the sheet named on its left end: Data!A2:A13.
            if end.sheet.is_none() {
                end.sheet = start_reference.sheet.clone();
            }
            return Ok(Expr::Range(start_reference, end));
        }
        Ok(Expr::Ref(start_reference))
    }
}

/// `Sheet1!$B$2` → a zero-based address. `$` is dropped: this evaluator never
/// moves a formula, so absolute and relative mean the same thing to it.
pub fn parse_reference(text: &str) -> Option<CellRef> {
    let (sheet, cell) = match text.rfind('!') {
        Some(index) => (
            Some(text[..index].trim_matches('\'').to_owned()),
            &text[index + 1..],
        ),
        None => (None, text),
    };
    let cell = cell.replace('$', "");
    let split = cell.find(|character: char| character.is_ascii_digit())?;
    let (letters, digits) = cell.split_at(split);
    if letters.is_empty() || digits.is_empty() {
        return None;
    }
    let mut column = 0u32;
    for character in letters.chars() {
        if !character.is_ascii_alphabetic() {
            return None;
        }
        column = column * 26 + (character.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
    }
    let row: u32 = digits.parse().ok()?;
    if row == 0 || column == 0 {
        return None;
    }
    Some(CellRef {
        sheet,
        row: row - 1,
        column: column - 1,
    })
}

/// Zero-based column index to letters, for messages a person reads.
pub fn column_letters(mut column: u32) -> String {
    let mut letters = String::new();
    column += 1;
    while column > 0 {
        let remainder = ((column - 1) % 26) as u8;
        letters.insert(0, (b'A' + remainder) as char);
        column = (column - 1) / 26;
    }
    letters
}

pub fn address_of(reference: &CellRef) -> String {
    format!("{}{}", column_letters(reference.column), reference.row + 1)
}

/* -------------------------------- evaluation ------------------------------- */

pub struct Evaluator<'a> {
    sheet: &'a dyn Sheet,
    /// Cells currently being evaluated, which is how a circular reference is
    /// caught rather than becoming a stack overflow.
    in_progress: Vec<CellRef>,
    cache: BTreeMap<CellRef, Value>,
}

impl<'a> Evaluator<'a> {
    pub fn new(sheet: &'a dyn Sheet) -> Self {
        Self {
            sheet,
            in_progress: Vec::new(),
            cache: BTreeMap::new(),
        }
    }

    /// Evaluates the cell at `reference`, following formulas it depends on.
    pub fn value(&mut self, reference: &CellRef) -> Value {
        if let Some(cached) = self.cache.get(reference) {
            return cached.clone();
        }
        if self.in_progress.contains(reference) {
            return Value::Error("#CIRCULAR!");
        }
        let Some(formula) = self.sheet.formula_at(reference) else {
            return self.sheet.value_at(reference);
        };
        self.in_progress.push(reference.clone());
        let result = match parse(&formula) {
            Ok(expression) => self.evaluate(&expression, reference),
            // A formula this module cannot read is not an error in the file: it
            // is a gap in this module, and the cell keeps whatever Excel last
            // computed for it.
            Err(_) => Value::Error("#UNEVALUATED!"),
        };
        self.in_progress.pop();
        self.cache.insert(reference.clone(), result.clone());
        result
    }

    pub fn evaluate(&mut self, expression: &Expr, origin: &CellRef) -> Value {
        match expression {
            Expr::Number(value) => Value::Number(*value),
            Expr::Text(value) => Value::Text(value.clone()),
            Expr::Bool(value) => Value::Bool(*value),
            Expr::Ref(reference) => {
                let resolved = self.qualify(reference, origin);
                self.value(&resolved)
            }
            Expr::Range(..) => Value::Error("#VALUE!"),
            Expr::Unary('-', inner) => match self.evaluate(inner, origin).as_number() {
                Ok(value) => Value::Number(-value),
                Err(code) => Value::Error(code),
            },
            Expr::Unary(..) => Value::Error("#VALUE!"),
            Expr::Binary(operator, left, right) => self.binary(operator, left, right, origin),
            Expr::Call(name, arguments) => self.call(name, arguments, origin),
        }
    }

    fn qualify(&self, reference: &CellRef, origin: &CellRef) -> CellRef {
        CellRef {
            sheet: reference.sheet.clone().or_else(|| origin.sheet.clone()),
            row: reference.row,
            column: reference.column,
        }
    }

    fn binary(&mut self, operator: &str, left: &Expr, right: &Expr, origin: &CellRef) -> Value {
        let left_value = self.evaluate(left, origin);
        let right_value = self.evaluate(right, origin);
        if let Value::Error(code) = left_value {
            return Value::Error(code);
        }
        if let Value::Error(code) = right_value {
            return Value::Error(code);
        }
        if operator == "&" {
            return match (left_value.as_text(), right_value.as_text()) {
                (Ok(a), Ok(b)) => Value::Text(format!("{a}{b}")),
                _ => Value::Error("#VALUE!"),
            };
        }
        if matches!(operator, "=" | "<>" | "<" | "<=" | ">" | ">=") {
            return compare(operator, &left_value, &right_value);
        }
        let (a, b) = match (left_value.as_number(), right_value.as_number()) {
            (Ok(a), Ok(b)) => (a, b),
            (Err(code), _) | (_, Err(code)) => return Value::Error(code),
        };
        match operator {
            "+" => Value::Number(a + b),
            "-" => Value::Number(a - b),
            "*" => Value::Number(a * b),
            "/" => {
                if b == 0.0 {
                    Value::Error("#DIV/0!")
                } else {
                    Value::Number(a / b)
                }
            }
            "^" => Value::Number(a.powf(b)),
            _ => Value::Error("#VALUE!"),
        }
    }

    /// Flattens an argument into the list of values a function sees.
    fn values_of(&mut self, expression: &Expr, origin: &CellRef) -> Vec<Value> {
        match expression {
            Expr::Range(start, end) => {
                let start = self.qualify(start, origin);
                let end = self.qualify(end, origin);
                let mut values = Vec::new();
                for row in start.row.min(end.row)..=start.row.max(end.row) {
                    for column in start.column.min(end.column)..=start.column.max(end.column) {
                        values.push(self.value(&CellRef {
                            sheet: start.sheet.clone(),
                            row,
                            column,
                        }));
                    }
                }
                values
            }
            other => vec![self.evaluate(other, origin)],
        }
    }

    fn numbers_of(
        &mut self,
        expression: &Expr,
        origin: &CellRef,
    ) -> Result<Vec<f64>, &'static str> {
        let mut numbers = Vec::new();
        for value in self.values_of(expression, origin) {
            match value {
                // A range skips its blanks and its labels the way Excel does;
                // SUM over a column with a header must not be #VALUE!.
                Value::Empty | Value::Text(_) => continue,
                Value::Error(code) => return Err(code),
                other => numbers.push(other.as_number()?),
            }
        }
        Ok(numbers)
    }

    fn call(&mut self, name: &str, arguments: &[Expr], origin: &CellRef) -> Value {
        match name {
            "SUM" | "AVERAGE" | "MIN" | "MAX" | "COUNT" => {
                let mut numbers = Vec::new();
                for argument in arguments {
                    match self.numbers_of(argument, origin) {
                        Ok(values) => numbers.extend(values),
                        Err(code) => return Value::Error(code),
                    }
                }
                match name {
                    "SUM" => Value::Number(numbers.iter().sum()),
                    "COUNT" => Value::Number(numbers.len() as f64),
                    "AVERAGE" => {
                        if numbers.is_empty() {
                            Value::Error("#DIV/0!")
                        } else {
                            Value::Number(numbers.iter().sum::<f64>() / numbers.len() as f64)
                        }
                    }
                    "MIN" => Value::Number(numbers.iter().copied().fold(f64::INFINITY, f64::min)),
                    _ => Value::Number(numbers.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
                }
            }
            "COUNTA" => {
                let mut count = 0;
                for argument in arguments {
                    for value in self.values_of(argument, origin) {
                        if !matches!(value, Value::Empty) {
                            count += 1;
                        }
                    }
                }
                Value::Number(count as f64)
            }
            "COUNTIF" | "SUMIF" | "AVERAGEIF" => self.single_criteria(name, arguments, origin),
            "COUNTIFS" | "SUMIFS" | "AVERAGEIFS" => self.multi_criteria(name, arguments, origin),
            "ABS" => self.one_number(arguments, origin, f64::abs),
            "ROUND" | "ROUNDUP" | "ROUNDDOWN" => self.rounding(name, arguments, origin),
            "IF" => {
                if arguments.len() < 2 {
                    return Value::Error("#VALUE!");
                }
                match self.evaluate(&arguments[0], origin).truthy() {
                    Ok(true) => self.evaluate(&arguments[1], origin),
                    Ok(false) => arguments
                        .get(2)
                        .map(|branch| self.evaluate(branch, origin))
                        .unwrap_or(Value::Bool(false)),
                    Err(code) => Value::Error(code),
                }
            }
            "IFERROR" | "IFNA" => {
                if arguments.len() != 2 {
                    return Value::Error("#VALUE!");
                }
                let value = self.evaluate(&arguments[0], origin);
                let caught = matches!(
                    (&value, name),
                    (Value::Error("#N/A"), _) | (Value::Error(_), "IFERROR")
                );
                if caught {
                    self.evaluate(&arguments[1], origin)
                } else {
                    value
                }
            }
            "AND" | "OR" => {
                let mut result = name == "AND";
                for argument in arguments {
                    for value in self.values_of(argument, origin) {
                        match value.truthy() {
                            Ok(truth) => {
                                if name == "AND" {
                                    result &= truth;
                                } else {
                                    result |= truth;
                                }
                            }
                            Err(code) => return Value::Error(code),
                        }
                    }
                }
                Value::Bool(result)
            }
            "NOT" => match self.evaluate(&arguments[0], origin).truthy() {
                Ok(value) => Value::Bool(!value),
                Err(code) => Value::Error(code),
            },
            "LEN" => match self.text_argument(arguments, 0, origin) {
                Ok(text) => Value::Number(text.chars().count() as f64),
                Err(code) => Value::Error(code),
            },
            "TRIM" => match self.text_argument(arguments, 0, origin) {
                Ok(text) => Value::Text(text.split_whitespace().collect::<Vec<_>>().join(" ")),
                Err(code) => Value::Error(code),
            },
            "LEFT" | "RIGHT" => self.side(name, arguments, origin),
            "MID" => self.mid(arguments, origin),
            "CONCAT" | "CONCATENATE" => {
                let mut joined = String::new();
                for argument in arguments {
                    for value in self.values_of(argument, origin) {
                        match value.as_text() {
                            Ok(text) => joined.push_str(&text),
                            Err(code) => return Value::Error(code),
                        }
                    }
                }
                Value::Text(joined)
            }
            "N" => match self.evaluate(&arguments[0], origin).as_number() {
                Ok(value) => Value::Number(value),
                Err(_) => Value::Number(0.0),
            },
            "TEXT" => match self.text_argument(arguments, 0, origin) {
                Ok(text) => Value::Text(text),
                Err(code) => Value::Error(code),
            },
            "MATCH" => self.match_function(arguments, origin),
            "INDEX" => self.index_function(arguments, origin),
            "VLOOKUP" | "HLOOKUP" | "XLOOKUP" => self.lookup(name, arguments, origin),
            // Dates and money are evaluated for their error behaviour rather
            // than for a value we would then report: a workbook's dates come
            // from the file, and a wrong serial would be worse than none.
            "TODAY" | "DATE" | "YEAR" | "MONTH" | "DAY" | "EOMONTH" | "PMT" | "FV" | "PV"
            | "RATE" => Value::Error("#UNEVALUATED!"),
            _ => Value::Error("#NAME?"),
        }
    }

    fn one_number(&mut self, arguments: &[Expr], origin: &CellRef, apply: fn(f64) -> f64) -> Value {
        match arguments
            .first()
            .map(|argument| self.evaluate(argument, origin))
            .unwrap_or(Value::Error("#VALUE!"))
            .as_number()
        {
            Ok(value) => Value::Number(apply(value)),
            Err(code) => Value::Error(code),
        }
    }

    fn rounding(&mut self, name: &str, arguments: &[Expr], origin: &CellRef) -> Value {
        let value = match arguments
            .first()
            .map(|argument| self.evaluate(argument, origin))
            .unwrap_or(Value::Error("#VALUE!"))
            .as_number()
        {
            Ok(value) => value,
            Err(code) => return Value::Error(code),
        };
        let digits = arguments
            .get(1)
            .map(|argument| self.evaluate(argument, origin))
            .unwrap_or(Value::Number(0.0))
            .as_number()
            .unwrap_or(0.0);
        let factor = 10f64.powf(digits);
        let scaled = value * factor;
        let rounded = match name {
            "ROUNDUP" => {
                if scaled < 0.0 {
                    scaled.floor()
                } else {
                    scaled.ceil()
                }
            }
            "ROUNDDOWN" => scaled.trunc(),
            _ => scaled.round(),
        };
        Value::Number(rounded / factor)
    }

    fn text_argument(
        &mut self,
        arguments: &[Expr],
        index: usize,
        origin: &CellRef,
    ) -> Result<String, &'static str> {
        arguments
            .get(index)
            .map(|argument| self.evaluate(argument, origin))
            .unwrap_or(Value::Empty)
            .as_text()
    }

    fn side(&mut self, name: &str, arguments: &[Expr], origin: &CellRef) -> Value {
        let text = match self.text_argument(arguments, 0, origin) {
            Ok(text) => text,
            Err(code) => return Value::Error(code),
        };
        let count = arguments
            .get(1)
            .map(|argument| self.evaluate(argument, origin))
            .unwrap_or(Value::Number(1.0))
            .as_number()
            .unwrap_or(1.0)
            .max(0.0) as usize;
        let characters: Vec<char> = text.chars().collect();
        let taken: String = if name == "LEFT" {
            characters.iter().take(count).collect()
        } else {
            characters
                .iter()
                .skip(characters.len().saturating_sub(count))
                .collect()
        };
        Value::Text(taken)
    }

    fn mid(&mut self, arguments: &[Expr], origin: &CellRef) -> Value {
        let text = match self.text_argument(arguments, 0, origin) {
            Ok(text) => text,
            Err(code) => return Value::Error(code),
        };
        let start = arguments
            .get(1)
            .map(|argument| self.evaluate(argument, origin))
            .unwrap_or(Value::Number(1.0))
            .as_number()
            .unwrap_or(1.0);
        if start < 1.0 {
            return Value::Error("#VALUE!");
        }
        let count = arguments
            .get(2)
            .map(|argument| self.evaluate(argument, origin))
            .unwrap_or(Value::Number(0.0))
            .as_number()
            .unwrap_or(0.0)
            .max(0.0) as usize;
        Value::Text(
            text.chars()
                .skip(start as usize - 1)
                .take(count)
                .collect::<String>(),
        )
    }

    /// `COUNTIF`, `SUMIF`, `AVERAGEIF`.
    fn single_criteria(&mut self, name: &str, arguments: &[Expr], origin: &CellRef) -> Value {
        if arguments.len() < 2 {
            return Value::Error("#VALUE!");
        }
        let subject = self.values_of(&arguments[0], origin);
        let criterion = self.evaluate(&arguments[1], origin);
        let summed = match name {
            "COUNTIF" => None,
            _ => Some(self.values_of(arguments.get(2).unwrap_or(&arguments[0]), origin)),
        };
        let mut matched = Vec::new();
        for (index, value) in subject.iter().enumerate() {
            if !matches_criterion(value, &criterion) {
                continue;
            }
            match &summed {
                None => matched.push(1.0),
                Some(values) => match values.get(index).map(Value::as_number) {
                    Some(Ok(number)) => matched.push(number),
                    Some(Err(code)) => return Value::Error(code),
                    None => {}
                },
            }
        }
        match name {
            "COUNTIF" => Value::Number(matched.len() as f64),
            "SUMIF" => Value::Number(matched.iter().sum()),
            _ => {
                if matched.is_empty() {
                    Value::Error("#DIV/0!")
                } else {
                    Value::Number(matched.iter().sum::<f64>() / matched.len() as f64)
                }
            }
        }
    }

    /// `COUNTIFS`, `SUMIFS`, `AVERAGEIFS` — pairs of range and criterion.
    fn multi_criteria(&mut self, name: &str, arguments: &[Expr], origin: &CellRef) -> Value {
        let (values, pairs) = if name == "COUNTIFS" {
            (None, arguments)
        } else {
            if arguments.is_empty() {
                return Value::Error("#VALUE!");
            }
            (Some(self.values_of(&arguments[0], origin)), &arguments[1..])
        };
        if pairs.len() % 2 != 0 || pairs.is_empty() {
            return Value::Error("#VALUE!");
        }
        let mut keep: Option<Vec<bool>> = None;
        let mut index = 0;
        while index < pairs.len() {
            let subject = self.values_of(&pairs[index], origin);
            let criterion = self.evaluate(&pairs[index + 1], origin);
            let mask: Vec<bool> = subject
                .iter()
                .map(|value| matches_criterion(value, &criterion))
                .collect();
            keep = Some(match keep {
                None => mask,
                Some(existing) => existing
                    .iter()
                    .zip(mask.iter())
                    .map(|(left, right)| *left && *right)
                    .collect(),
            });
            index += 2;
        }
        let mask = keep.unwrap_or_default();
        match (name, values) {
            ("COUNTIFS", _) => Value::Number(mask.iter().filter(|keep| **keep).count() as f64),
            (_, Some(values)) => {
                let mut kept = Vec::new();
                for (position, value) in values.iter().enumerate() {
                    if !mask.get(position).copied().unwrap_or(false) {
                        continue;
                    }
                    match value.as_number() {
                        Ok(number) => kept.push(number),
                        Err(code) => return Value::Error(code),
                    }
                }
                if name == "SUMIFS" {
                    Value::Number(kept.iter().sum())
                } else if kept.is_empty() {
                    Value::Error("#DIV/0!")
                } else {
                    Value::Number(kept.iter().sum::<f64>() / kept.len() as f64)
                }
            }
            _ => Value::Error("#VALUE!"),
        }
    }

    fn match_function(&mut self, arguments: &[Expr], origin: &CellRef) -> Value {
        if arguments.len() < 2 {
            return Value::Error("#VALUE!");
        }
        let needle = self.evaluate(&arguments[0], origin);
        let haystack = self.values_of(&arguments[1], origin);
        // Only exact match is implemented: an approximate MATCH over unsorted
        // data returns a plausible wrong answer, which is worse than none.
        for (index, value) in haystack.iter().enumerate() {
            if same_value(value, &needle) {
                return Value::Number(index as f64 + 1.0);
            }
        }
        Value::Error("#N/A")
    }

    fn index_function(&mut self, arguments: &[Expr], origin: &CellRef) -> Value {
        if arguments.len() < 2 {
            return Value::Error("#VALUE!");
        }
        let values = self.values_of(&arguments[0], origin);
        let position = match self.evaluate(&arguments[1], origin).as_number() {
            Ok(value) => value,
            Err(code) => return Value::Error(code),
        };
        if position < 1.0 {
            return Value::Error("#VALUE!");
        }
        values
            .get(position as usize - 1)
            .cloned()
            .unwrap_or(Value::Error("#REF!"))
    }

    fn lookup(&mut self, name: &str, arguments: &[Expr], origin: &CellRef) -> Value {
        if arguments.len() < 3 {
            return Value::Error("#VALUE!");
        }
        let needle = self.evaluate(&arguments[0], origin);
        if name == "XLOOKUP" {
            let haystack = self.values_of(&arguments[1], origin);
            let results = self.values_of(&arguments[2], origin);
            for (index, value) in haystack.iter().enumerate() {
                if same_value(value, &needle) {
                    return results.get(index).cloned().unwrap_or(Value::Error("#REF!"));
                }
            }
            return arguments
                .get(3)
                .map(|fallback| self.evaluate(fallback, origin))
                .unwrap_or(Value::Error("#N/A"));
        }

        // VLOOKUP and HLOOKUP need the range's shape, which only a Range
        // expression carries — a flattened list cannot say where the rows end.
        let Expr::Range(start, end) = &arguments[1] else {
            return Value::Error("#VALUE!");
        };
        let start = self.qualify(start, origin);
        let end = self.qualify(end, origin);
        let offset = match self.evaluate(&arguments[2], origin).as_number() {
            Ok(value) => value,
            Err(code) => return Value::Error(code),
        };
        if offset < 1.0 {
            return Value::Error("#VALUE!");
        }
        let offset = offset as u32 - 1;
        let (first_row, last_row) = (start.row.min(end.row), start.row.max(end.row));
        let (first_column, last_column) =
            (start.column.min(end.column), start.column.max(end.column));

        if name == "VLOOKUP" {
            if first_column + offset > last_column {
                return Value::Error("#REF!");
            }
            for row in first_row..=last_row {
                let key = self.value(&CellRef {
                    sheet: start.sheet.clone(),
                    row,
                    column: first_column,
                });
                if same_value(&key, &needle) {
                    return self.value(&CellRef {
                        sheet: start.sheet.clone(),
                        row,
                        column: first_column + offset,
                    });
                }
            }
        } else {
            if first_row + offset > last_row {
                return Value::Error("#REF!");
            }
            for column in first_column..=last_column {
                let key = self.value(&CellRef {
                    sheet: start.sheet.clone(),
                    row: first_row,
                    column,
                });
                if same_value(&key, &needle) {
                    return self.value(&CellRef {
                        sheet: start.sheet.clone(),
                        row: first_row + offset,
                        column,
                    });
                }
            }
        }
        Value::Error("#N/A")
    }
}

fn same_value(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => (a - b).abs() < f64::EPSILON,
        (Value::Text(a), Value::Text(b)) => a.eq_ignore_ascii_case(b),
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::Empty, Value::Empty) => true,
        _ => false,
    }
}

fn compare(operator: &str, left: &Value, right: &Value) -> Value {
    let ordering = match (left, right) {
        (Value::Text(a), Value::Text(b)) => a.to_lowercase().partial_cmp(&b.to_lowercase()),
        _ => match (left.as_number(), right.as_number()) {
            (Ok(a), Ok(b)) => a.partial_cmp(&b),
            _ => return Value::Error("#VALUE!"),
        },
    };
    let Some(ordering) = ordering else {
        return Value::Error("#VALUE!");
    };
    Value::Bool(match operator {
        "=" => ordering.is_eq(),
        "<>" => ordering.is_ne(),
        "<" => ordering.is_lt(),
        "<=" => ordering.is_le(),
        ">" => ordering.is_gt(),
        _ => ordering.is_ge(),
    })
}

/// Excel's criteria language: a bare value, or a comparison in a string.
fn matches_criterion(value: &Value, criterion: &Value) -> bool {
    let Value::Text(text) = criterion else {
        return same_value(value, criterion);
    };
    let trimmed = text.trim();
    for operator in [">=", "<=", "<>", ">", "<", "="] {
        if let Some(rest) = trimmed.strip_prefix(operator) {
            let target = rest
                .trim()
                .parse::<f64>()
                .map(Value::Number)
                .unwrap_or_else(|_| Value::Text(rest.trim().to_owned()));
            return matches!(compare(operator, value, &target), Value::Bool(true));
        }
    }
    same_value(value, criterion)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        cells: BTreeMap<(u32, u32), Value>,
        formulas: BTreeMap<(u32, u32), String>,
    }

    impl Sheet for Fixture {
        fn value_at(&self, reference: &CellRef) -> Value {
            self.cells
                .get(&(reference.row, reference.column))
                .cloned()
                .unwrap_or(Value::Empty)
        }
        fn formula_at(&self, reference: &CellRef) -> Option<String> {
            self.formulas
                .get(&(reference.row, reference.column))
                .cloned()
        }
    }

    fn sheet() -> Fixture {
        let mut cells = BTreeMap::new();
        // A1:A4 = 10, 20, 30, "Total"; B1:B4 = 1, 0, 3, ""
        cells.insert((0, 0), Value::Number(10.0));
        cells.insert((1, 0), Value::Number(20.0));
        cells.insert((2, 0), Value::Number(30.0));
        cells.insert((3, 0), Value::Text("Total".into()));
        cells.insert((0, 1), Value::Number(1.0));
        cells.insert((1, 1), Value::Number(0.0));
        cells.insert((2, 1), Value::Number(3.0));
        Fixture {
            cells,
            formulas: BTreeMap::new(),
        }
    }

    fn evaluate(formula: &str) -> Value {
        let fixture = sheet();
        let mut evaluator = Evaluator::new(&fixture);
        let expression = parse(formula).expect("parses");
        evaluator.evaluate(
            &expression,
            &CellRef {
                sheet: None,
                row: 9,
                column: 9,
            },
        )
    }

    #[test]
    fn arithmetic_and_precedence_follow_the_spreadsheet_rules() {
        assert_eq!(evaluate("1+2*3"), Value::Number(7.0));
        assert_eq!(evaluate("(1+2)*3"), Value::Number(9.0));
        assert_eq!(evaluate("2^3"), Value::Number(8.0));
        assert_eq!(evaluate("-A1"), Value::Number(-10.0));
        assert_eq!(evaluate("50%"), Value::Number(0.5));
        assert_eq!(evaluate("\"a\"&\"b\""), Value::Text("ab".into()));
    }

    #[test]
    fn a_division_by_zero_is_the_error_excel_would_show() {
        assert_eq!(evaluate("A1/B2"), Value::Error("#DIV/0!"));
        // And it propagates rather than being swallowed.
        assert_eq!(evaluate("SUM(A1:A3)+A1/B2"), Value::Error("#DIV/0!"));
        assert_eq!(evaluate("IFERROR(A1/B2,0)"), Value::Number(0.0));
    }

    #[test]
    fn aggregates_skip_the_labels_a_column_carries() {
        // A4 is the word "Total"; SUM over the column must not be #VALUE!.
        assert_eq!(evaluate("SUM(A1:A4)"), Value::Number(60.0));
        assert_eq!(evaluate("COUNT(A1:A4)"), Value::Number(3.0));
        assert_eq!(evaluate("COUNTA(A1:A4)"), Value::Number(4.0));
        assert_eq!(evaluate("AVERAGE(A1:A3)"), Value::Number(20.0));
        assert_eq!(evaluate("MIN(A1:A3)"), Value::Number(10.0));
        assert_eq!(evaluate("MAX(A1:A3)"), Value::Number(30.0));
    }

    #[test]
    fn criteria_understand_the_comparison_strings_excel_takes() {
        assert_eq!(evaluate("COUNTIF(A1:A3,\">15\")"), Value::Number(2.0));
        assert_eq!(evaluate("SUMIF(A1:A3,\">15\")"), Value::Number(50.0));
        assert_eq!(evaluate("SUMIF(A1:A3,\">15\",B1:B3)"), Value::Number(3.0));
        assert_eq!(
            evaluate("COUNTIFS(A1:A3,\">5\",B1:B3,\">0\")"),
            Value::Number(2.0)
        );
    }

    #[test]
    fn lookups_are_exact_and_say_not_available_rather_than_guessing() {
        assert_eq!(evaluate("MATCH(20,A1:A3)"), Value::Number(2.0));
        assert_eq!(evaluate("MATCH(99,A1:A3)"), Value::Error("#N/A"));
        assert_eq!(evaluate("INDEX(A1:A3,3)"), Value::Number(30.0));
        assert_eq!(evaluate("INDEX(A1:A3,9)"), Value::Error("#REF!"));
        assert_eq!(evaluate("VLOOKUP(20,A1:B3,2)"), Value::Number(0.0));
        assert_eq!(evaluate("XLOOKUP(30,A1:A3,B1:B3)"), Value::Number(3.0));
        assert_eq!(
            evaluate("XLOOKUP(99,A1:A3,B1:B3,\"none\")"),
            Value::Text("none".into())
        );
    }

    #[test]
    fn text_functions_count_characters_rather_than_bytes() {
        assert_eq!(evaluate("LEN(\"héllo\")"), Value::Number(5.0));
        assert_eq!(evaluate("LEFT(\"héllo\",2)"), Value::Text("hé".into()));
        assert_eq!(evaluate("RIGHT(\"héllo\",2)"), Value::Text("lo".into()));
        assert_eq!(evaluate("MID(\"héllo\",2,3)"), Value::Text("éll".into()));
        assert_eq!(evaluate("TRIM(\"  a   b \")"), Value::Text("a b".into()));
        assert_eq!(evaluate("CONCAT(\"a\",A1)"), Value::Text("a10".into()));
    }

    #[test]
    fn a_function_outside_the_allowlist_is_refused_by_name() {
        match parse("=INDIRECT(A1)".trim_start_matches('=')) {
            Err(ParseError::NotAllowed(name)) => assert_eq!(name, "INDIRECT"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(is_allowed("sum"));
        assert!(!is_allowed("INDIRECT"));
    }

    #[test]
    fn a_circular_reference_terminates_instead_of_overflowing_the_stack() {
        let mut formulas = BTreeMap::new();
        formulas.insert((0, 0), "B1+1".to_owned());
        formulas.insert((0, 1), "A1+1".to_owned());
        let fixture = Fixture {
            cells: BTreeMap::new(),
            formulas,
        };
        let mut evaluator = Evaluator::new(&fixture);
        assert_eq!(
            evaluator.value(&CellRef {
                sheet: None,
                row: 0,
                column: 0
            }),
            Value::Error("#CIRCULAR!")
        );
    }

    #[test]
    fn references_parse_the_way_a_person_writes_them() {
        assert_eq!(
            parse_reference("$B$2"),
            Some(CellRef {
                sheet: None,
                row: 1,
                column: 1
            })
        );
        assert_eq!(
            parse_reference("Data!AA10"),
            Some(CellRef {
                sheet: Some("Data".into()),
                row: 9,
                column: 26
            })
        );
        assert_eq!(parse_reference("notacell"), None);
        assert_eq!(column_letters(0), "A");
        assert_eq!(column_letters(26), "AA");
    }

    #[test]
    fn a_function_we_do_not_evaluate_says_so_rather_than_reporting_a_number() {
        // The date and money functions are allowlisted for writing but not
        // evaluated: a wrong serial would be worse than an honest gap.
        assert_eq!(evaluate("TODAY()"), Value::Error("#UNEVALUATED!"));
        assert_eq!(evaluate("PMT(0.05,10,1000)"), Value::Error("#UNEVALUATED!"));
    }
}
