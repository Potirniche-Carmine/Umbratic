//! Synthetic PDF builders for tests (this crate, the CLI, and the runner).
//! Kept in the library so fixtures are generated at test time instead of
//! committing binary files.

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, Stream, dictionary};

/// One page of a synthetic fixture document.
pub enum FixturePage<'a> {
    /// A page whose text layer is the given string (lines become text lines).
    Text(&'a str),
    /// A page with this many 1x1 raster image XObjects and no text.
    Images(usize),
    /// A page with no content at all.
    Empty,
}

pub fn build_pdf(pages: &[FixturePage<'_>]) -> Vec<u8> {
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let font_id = document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let mut kids: Vec<Object> = Vec::new();
    for page in pages {
        let mut resources = dictionary! { "Font" => dictionary! { "F1" => font_id } };
        let mut operations: Vec<Operation> = Vec::new();
        match page {
            FixturePage::Text(text) => push_text_operations(&mut operations, text),
            FixturePage::Images(count) => {
                let mut xobjects = Dictionary::new();
                for index in 0..*count {
                    let image_id = document.add_object(Stream::new(
                        dictionary! {
                            "Type" => "XObject",
                            "Subtype" => "Image",
                            "Width" => 1,
                            "Height" => 1,
                            "ColorSpace" => "DeviceGray",
                            "BitsPerComponent" => 8,
                        },
                        vec![0u8],
                    ));
                    let name = format!("Im{index}");
                    xobjects.set(name.as_bytes(), image_id);
                    operations.push(Operation::new("q", vec![]));
                    operations.push(Operation::new(
                        "cm",
                        vec![
                            612.into(),
                            0.into(),
                            0.into(),
                            792.into(),
                            0.into(),
                            0.into(),
                        ],
                    ));
                    operations.push(Operation::new("Do", vec![name.as_str().into()]));
                    operations.push(Operation::new("Q", vec![]));
                }
                resources.set("XObject", xobjects);
            }
            FixturePage::Empty => {}
        }
        push_page(&mut document, pages_id, resources, operations, &mut kids);
    }
    finish_document(document, pages_id, kids)
}

/// A one-page document whose text is drawn with `TJ` kerning offsets; word
/// gaps are encoded as large negative adjustments instead of space glyphs.
pub fn tj_offsets_pdf() -> Vec<u8> {
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let font_id = document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });
    let operations = vec![
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec!["F1".into(), 12.into()]),
        Operation::new("Td", vec![72.into(), 720.into()]),
        Operation::new(
            "TJ",
            vec![Object::Array(vec![
                Object::string_literal("Umbratic"),
                (-250).into(),
                Object::string_literal("native"),
                (-30).into(),
                Object::string_literal("inspector"),
                (-250).into(),
                Object::string_literal("classification"),
                (-250).into(),
                Object::string_literal("pipeline"),
            ])],
        ),
        Operation::new("ET", vec![]),
    ];
    let resources = dictionary! { "Font" => dictionary! { "F1" => font_id } };
    let mut kids = Vec::new();
    push_page(&mut document, pages_id, resources, operations, &mut kids);
    finish_document(document, pages_id, kids)
}

/// A one-page document whose show-text operations reference a font that is
/// missing from the page resources, so nothing can be decoded.
pub fn undecodable_text_pdf() -> Vec<u8> {
    let mut document = Document::with_version("1.5");
    let pages_id = document.new_object_id();
    let mut operations = vec![
        Operation::new("BT", vec![]),
        Operation::new("Tf", vec!["Missing".into(), 12.into()]),
        Operation::new("Td", vec![72.into(), 720.into()]),
    ];
    for _ in 0..4 {
        operations.push(Operation::new(
            "Tj",
            vec![Object::string_literal("undecodable run of text")],
        ));
        operations.push(Operation::new("Td", vec![0.into(), (-14).into()]));
    }
    operations.push(Operation::new("ET", vec![]));
    let mut kids = Vec::new();
    push_page(
        &mut document,
        pages_id,
        Dictionary::new(),
        operations,
        &mut kids,
    );
    finish_document(document, pages_id, kids)
}

fn push_text_operations(operations: &mut Vec<Operation>, text: &str) {
    operations.push(Operation::new("BT", vec![]));
    operations.push(Operation::new("Tf", vec!["F1".into(), 12.into()]));
    operations.push(Operation::new("Td", vec![72.into(), 720.into()]));
    for (index, line) in text.lines().enumerate() {
        if index > 0 {
            operations.push(Operation::new("Td", vec![0.into(), (-14).into()]));
        }
        operations.push(Operation::new("Tj", vec![Object::string_literal(line)]));
    }
    operations.push(Operation::new("ET", vec![]));
}

fn push_page(
    document: &mut Document,
    pages_id: lopdf::ObjectId,
    resources: Dictionary,
    operations: Vec<Operation>,
    kids: &mut Vec<Object>,
) {
    let content = Content { operations };
    let content_id = document.add_object(Stream::new(
        Dictionary::new(),
        content.encode().expect("fixture content encodes"),
    ));
    let page_id = document.add_object(dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Contents" => content_id,
        "Resources" => resources,
        "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
    });
    kids.push(page_id.into());
}

fn finish_document(
    mut document: Document,
    pages_id: lopdf::ObjectId,
    kids: Vec<Object>,
) -> Vec<u8> {
    let count = kids.len() as i64;
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => kids,
            "Count" => count,
        }),
    );
    let catalog_id = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog_id);
    let mut buffer = Vec::new();
    document
        .save_to(&mut buffer)
        .expect("fixture document serializes");
    buffer
}
