package instances

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/ionnet/gsm/agent/internal/protocol"
)

// ApplyConfigFile creates or updates one config file under root with the given values.
func ApplyConfigFile(root string, spec protocol.ConfigFileSpec, uid, gid int) error {
	for _, seg := range strings.Split(spec.Path, "/") {
		if seg == ".." {
			return fmt.Errorf("config file %q escapes the instance", spec.Path)
		}
	}
	rel := filepath.Clean("/" + spec.Path)
	path := filepath.Join(root, rel)
	if !strings.HasPrefix(path, filepath.Clean(root)+string(filepath.Separator)) {
		return fmt.Errorf("config file %q escapes the instance", spec.Path)
	}
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	err = nil
	var out []byte
	switch spec.Format {
	case "properties":
		out = MergeProperties(existing, spec.Values)
	case "json":
		out, err = MergeJSON(existing, spec.Values)
	case "ini":
		out = MergeINI(existing, spec.Values)
	case "yaml":
		out, err = MergeYAML(existing, spec.Values)
	case "xml-properties":
		out = MergeXMLProperties(existing, spec.Values)
	default:
		return fmt.Errorf("unknown config file format %q", spec.Format)
	}
	if err != nil {
		return fmt.Errorf("%s: %w", spec.Path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	_ = os.Chown(filepath.Dir(path), uid, gid)
	if err := os.WriteFile(path, out, 0o644); err != nil {
		return err
	}
	return os.Chown(path, uid, gid)
}

// MergeProperties sets keys in a Java .properties file, keeping other lines and comments.
func MergeProperties(existing []byte, values map[string]string) []byte {
	remaining := map[string]string{}
	for k, v := range values {
		remaining[k] = v
	}
	var out []string
	text := string(existing)
	if text != "" {
		for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "!") {
				out = append(out, line)
				continue
			}
			key := propertyKey(trimmed)
			if v, ok := remaining[key]; ok {
				out = append(out, key+"="+v)
				delete(remaining, key)
				continue
			}
			out = append(out, line)
		}
	}
	for _, k := range sortedKeys(remaining) {
		out = append(out, k+"="+remaining[k])
	}
	return []byte(strings.Join(out, "\n") + "\n")
}

func propertyKey(line string) string {
	i := strings.IndexAny(line, "=: \t")
	if i < 0 {
		return line
	}
	return line[:i]
}

// MergeINI sets keys in an INI file; "section.key" targets a [section], a bare key the top.
func MergeINI(existing []byte, values map[string]string) []byte {
	type kv struct{ section, key, value string }
	var wanted []kv
	for _, k := range sortedKeys(values) {
		section, key := "", k
		if i := strings.Index(k, "."); i > 0 {
			section, key = k[:i], k[i+1:]
		}
		wanted = append(wanted, kv{section, key, values[k]})
	}
	done := map[string]bool{}
	var out []string
	section := ""
	flushSection := func() {
		for _, w := range wanted {
			if w.section == section && !done[w.section+"."+w.key] {
				out = append(out, w.key+"="+w.value)
				done[w.section+"."+w.key] = true
			}
		}
	}
	text := string(existing)
	if text != "" {
		for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
				flushSection()
				section = strings.TrimSpace(trimmed[1 : len(trimmed)-1])
				out = append(out, line)
				continue
			}
			if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
				out = append(out, line)
				continue
			}
			key := propertyKey(trimmed)
			replaced := false
			for _, w := range wanted {
				if w.section == section && w.key == key {
					out = append(out, key+"="+w.value)
					done[w.section+"."+w.key] = true
					replaced = true
					break
				}
			}
			if !replaced {
				out = append(out, line)
			}
		}
	}
	flushSection()
	// Sections never seen get appended.
	seen := map[string]bool{"": true}
	for _, line := range out {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "[") && strings.HasSuffix(t, "]") {
			seen[strings.TrimSpace(t[1:len(t)-1])] = true
		}
	}
	for _, w := range wanted {
		if done[w.section+"."+w.key] {
			continue
		}
		if !seen[w.section] {
			out = append(out, "["+w.section+"]")
			seen[w.section] = true
			section = w.section
			for _, x := range wanted {
				if x.section == section && !done[x.section+"."+x.key] {
					out = append(out, x.key+"="+x.value)
					done[x.section+"."+x.key] = true
				}
			}
		}
	}
	return []byte(strings.Join(out, "\n") + "\n")
}

var (
	xmlTagOrComment = regexp.MustCompile(`(?s)<!--.*?-->|<property\b[^>]*>`)
	xmlNameAttr     = regexp.MustCompile(`\bname\s*=\s*"([^"]*)"`)
	xmlValueAttr    = regexp.MustCompile(`\bvalue\s*=\s*"[^"]*"`)
	xmlAttrEscaper  = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
)

// MergeXMLProperties sets `<property name="KEY" value="…"/>` elements (7 Days to Die's
// serverconfig.xml), keeping everything else as it is. Commented-out properties are left alone;
// properties not in the file yet are added before the root element's closing tag.
func MergeXMLProperties(existing []byte, values map[string]string) []byte {
	text := string(existing)
	if strings.TrimSpace(text) == "" {
		text = "<?xml version=\"1.0\"?>\n<ServerSettings>\n</ServerSettings>\n"
	}
	remaining := map[string]string{}
	for k, v := range values {
		remaining[k] = v
	}
	text = xmlTagOrComment.ReplaceAllStringFunc(text, func(tag string) string {
		if strings.HasPrefix(tag, "<!--") {
			return tag
		}
		m := xmlNameAttr.FindStringSubmatch(tag)
		if m == nil {
			return tag
		}
		v, ok := remaining[m[1]]
		if !ok {
			return tag
		}
		delete(remaining, m[1])
		attr := `value="` + xmlAttrEscaper.Replace(v) + `"`
		if xmlValueAttr.MatchString(tag) {
			return xmlValueAttr.ReplaceAllLiteralString(tag, attr)
		}
		end := strings.TrimSuffix(strings.TrimSuffix(tag, ">"), "/")
		return strings.TrimRight(end, " \t") + " " + attr + tag[len(end):]
	})
	if len(remaining) == 0 {
		return []byte(text)
	}
	var add strings.Builder
	for _, k := range sortedKeys(remaining) {
		add.WriteString("\t<property name=\"" + xmlAttrEscaper.Replace(k) + "\" value=\"" + xmlAttrEscaper.Replace(remaining[k]) + "\"/>\n")
	}
	i := strings.LastIndex(text, "</")
	if i < 0 {
		return []byte(text + add.String())
	}
	// New lines go where the closing tag's line starts, so its indentation stays; a closing tag
	// sharing its line with other content gets a line break first.
	lineStart := strings.LastIndex(text[:i], "\n") + 1
	if strings.TrimSpace(text[lineStart:i]) != "" {
		return []byte(text[:i] + "\n" + add.String() + text[i:])
	}
	return []byte(text[:lineStart] + add.String() + text[lineStart:])
}

// MergeJSON sets dotted keys in a JSON object, creating nested objects as needed. Values that
// parse as JSON numbers, booleans or null are stored typed; everything else as strings.
func MergeJSON(existing []byte, values map[string]string) ([]byte, error) {
	root := map[string]any{}
	if len(bytes.TrimSpace(existing)) > 0 {
		if err := json.Unmarshal(existing, &root); err != nil {
			return nil, fmt.Errorf("existing file is not a JSON object: %w", err)
		}
	}
	for _, k := range sortedKeys(values) {
		setNested(root, strings.Split(k, "."), typedValue(values[k]))
	}
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func setNested(m map[string]any, path []string, v any) {
	for i, p := range path {
		if i == len(path)-1 {
			m[p] = v
			return
		}
		next, ok := m[p].(map[string]any)
		if !ok {
			next = map[string]any{}
			m[p] = next
		}
		m = next
	}
}

// typedValue keeps numbers, booleans and null typed so "25565" becomes a JSON number.
func typedValue(s string) any {
	switch s {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	}
	var n json.Number
	if err := json.Unmarshal([]byte(s), &n); err == nil {
		if f, err := n.Float64(); err == nil {
			if i, err := n.Int64(); err == nil {
				return i
			}
			return f
		}
	}
	return s
}

// MergeYAML sets dotted keys in a YAML document, keeping comments and order of what is there.
func MergeYAML(existing []byte, values map[string]string) ([]byte, error) {
	var doc yaml.Node
	if len(bytes.TrimSpace(existing)) > 0 {
		if err := yaml.Unmarshal(existing, &doc); err != nil {
			return nil, err
		}
	}
	if doc.Kind == 0 {
		doc = yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}
	}
	if len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("existing file is not a YAML mapping")
	}
	for _, k := range sortedKeys(values) {
		setYAML(doc.Content[0], strings.Split(k, "."), values[k])
	}
	var buf bytes.Buffer
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return nil, err
	}
	_ = enc.Close()
	return buf.Bytes(), nil
}

func setYAML(m *yaml.Node, path []string, value string) {
	key := path[0]
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value != key {
			continue
		}
		if len(path) == 1 {
			old := m.Content[i+1]
			n := scalarNode(value)
			n.HeadComment, n.LineComment, n.FootComment = old.HeadComment, old.LineComment, old.FootComment
			m.Content[i+1] = n
			return
		}
		child := m.Content[i+1]
		if child.Kind != yaml.MappingNode {
			child = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			m.Content[i+1] = child
		}
		setYAML(child, path[1:], value)
		return
	}
	keyNode := &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}
	if len(path) == 1 {
		m.Content = append(m.Content, keyNode, scalarNode(value))
		return
	}
	child := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	m.Content = append(m.Content, keyNode, child)
	setYAML(child, path[1:], value)
}

func scalarNode(value string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.ScalarNode, Value: value}
	switch typedValue(value).(type) {
	case bool:
		n.Tag = "!!bool"
	case int64, float64:
		n.Tag = "!!int"
		if strings.ContainsAny(value, ".eE") {
			n.Tag = "!!float"
		}
	case nil:
		n.Tag = "!!null"
	default:
		n.Tag = "!!str"
		if value == "" || strings.ContainsAny(value, ":#{}[],&*!|>'\"%@`") {
			n.Style = yaml.DoubleQuotedStyle
		}
	}
	return n
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
