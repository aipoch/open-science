# Local Mind Map Implementation Reference

This reference is for local mind map rendering without external libraries; the single-file HTML can be opened directly.

## Data Format

Use Plain Text indentation to represent hierarchy, with 2 spaces per level by default.

Example:
```text
- Root Node
  - Child Node 1
    - Child Node 1-1
    - Child Node 1-2
  - Child Node 2
    - Child Node 2-1
```

Parsing Rules:
- Count leading spaces / 2 to get the depth.
- Optional `- ` prefix at the start of the line.
- Ignore empty lines.

## Rendering Goals

- Use native HTML/CSS/JS to draw nodes and connection lines.
- Nodes use absolute positioning; lines are overlaid using SVG.
- No dependency on any external libraries or network resources.

## Layout Strategy (Simplified Version)

- Arrange horizontally by level and vertically by DFS order.
- Leaf nodes occupy a fixed height; parent nodes are vertically centered between their children.
- Use fixed `LEVEL_GAP` and `ROW_GAP` to control spacing.

## Implementation Tips

- Fixed node height (avoiding line breaks) makes the layout logic more stable.
- Use 200-300ms debouncing when updating input to reduce repaints.
- Fall back to default example data if parsing fails.