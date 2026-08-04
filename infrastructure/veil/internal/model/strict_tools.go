package model

// strictTools marks each function strict for vLLM. The runner sends the
// canonical three-key function definition; strict mode is a provider detail, so
// it is applied here rather than travelling through the internal contract.
func strictTools(tools any) any {
	rows, ok := tools.([]any)
	if !ok {
		return tools
	}
	marked := make([]any, 0, len(rows))
	for _, raw := range rows {
		tool, ok := raw.(map[string]any)
		if !ok {
			marked = append(marked, raw)
			continue
		}
		function, ok := tool["function"].(map[string]any)
		if !ok {
			marked = append(marked, raw)
			continue
		}
		strictFunction := make(map[string]any, len(function)+1)
		for key, value := range function {
			strictFunction[key] = value
		}
		strictFunction["strict"] = true
		strictTool := make(map[string]any, len(tool))
		for key, value := range tool {
			strictTool[key] = value
		}
		strictTool["function"] = strictFunction
		marked = append(marked, strictTool)
	}
	return marked
}
