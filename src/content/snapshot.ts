// Renders CDP accessibility trees (Accessibility.getFullAXTree) as a compact,
// LLM-friendly outline with stable-per-snapshot refs:
//
//   - heading "Sign in" [level=1]
//   - textbox "Email" [ref=e3]
//   - checkbox "Remember me" [checked=false] [ref=e4]
//   - button "Continue" [ref=e5]
//
// The accessibility tree is computed on the COMPOSED (flat) tree, so content in
// open AND closed shadow roots is already there. Frames are separate trees; the
// caller passes them in and they are spliced under their <iframe> node.

export type AXNode = {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  description?: { value?: string };
  properties?: Array<{ name: string; value?: { value?: unknown } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
};

export type AXFrame = {
  // Owning CDP session (null = the page session) and target (OOPIF) id.
  sessionId: string | null;
  targetId: string | null;
  nodes: AXNode[];
  // backendDOMNodeId of the <iframe> element (in the PARENT frame) that hosts
  // this frame; null for the main frame.
  hostBackendNodeId: number | null;
  // Session that owns the host <iframe> element (null = the page session).
  hostSessionId?: string | null;
  url?: string;
};

export type SnapshotRef = {
  backendNodeId: number;
  sessionId: string | null;
  targetId: string | null;
  role: string;
  name: string;
};

export type SnapshotOptions = {
  // Only interactive elements (flat list) — the cheapest view for "what can I
  // click/type?". Default false (full outline).
  interactive?: boolean;
  // Truncate long names/text to this many characters (default 120).
  maxTextLength?: number;
};

export type SnapshotResult = {
  text: string;
  refs: Map<string, SnapshotRef>;
};

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
]);

// Rendering internals of the AX tree that only repeat their parent's text.
const NOISE_ROLES = new Set(["InlineTextBox", "ListMarker", "LineBreak"]);

// Structural roles that add nothing when unnamed: their children are promoted.
const TRANSPARENT_ROLES = new Set(["generic", "none", "presentation", "group", "LabelText", "RootWebArea", "WebArea", "Section", "paragraph", "div", "Pre"]);

const PROPERTY_FLAGS = ["checked", "pressed", "expanded", "selected", "disabled", "required", "level", "readonly", "invalid"];

export function renderSnapshot(frames: AXFrame[], options: SnapshotOptions = {}): SnapshotResult {
  const max = options.maxTextLength ?? 120;
  const refs = new Map<string, SnapshotRef>();
  const lines: string[] = [];
  let counter = 0;

  // host <iframe> backend id -> child frames (a frame's tree hangs off its host).
  const children_frames = new Map<string, AXFrame[]>();
  const frame_key = (sessionId: string | null, backend: number): string => `${sessionId ?? "page"}:${backend}`;
  const main = frames[0];
  for (const frame of frames.slice(1)) {
    if (frame.hostBackendNodeId == null) {
      continue;
    }
    const key = frame_key(frame.hostSessionId ?? null, frame.hostBackendNodeId);
    children_frames.set(key, [...(children_frames.get(key) ?? []), frame]);
  }
  const rendered_frames = new Set<AXFrame>();

  const clip = (text: string): string => {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  };

  const render_frame = (frame: AXFrame, depth: number): void => {
    if (rendered_frames.has(frame)) {
      return;
    }
    rendered_frames.add(frame);
    const by_id = new Map(frame.nodes.map((node) => [node.nodeId, node]));
    const child_ids = new Set(frame.nodes.flatMap((node) => node.childIds ?? []));
    const roots = frame.nodes.filter((node) => !child_ids.has(node.nodeId));

    const visit = (node: AXNode, depth: number, parent_name: string): void => {
      const role = String(node.role?.value ?? "");
      const name = clip(String(node.name?.value ?? ""));
      if (NOISE_ROLES.has(role)) {
        return;
      }
      const props = new Map((node.properties ?? []).map((prop) => [prop.name, prop.value?.value]));

      const is_text = role === "StaticText" || role === "text";
      const interactive = INTERACTIVE_ROLES.has(role) || props.get("focusable") === true && role !== "RootWebArea" && role !== "WebArea" && Boolean(name) && !is_text;
      const transparent = node.ignored || (TRANSPARENT_ROLES.has(role) && !name) || role === "RootWebArea" || role === "WebArea";

      let next_depth = depth;
      let printed = false;

      if (!transparent) {
        if (is_text) {
          // Skip text that just repeats its parent's accessible name.
          if (!options.interactive && name && !parent_name.includes(name)) {
            lines.push(`${"  ".repeat(depth)}- text: ${JSON.stringify(name)}`);
          }
        } else if (!options.interactive || interactive) {
          let line = `${"  ".repeat(options.interactive ? 0 : depth)}- ${role}`;
          if (name) {
            line += ` ${JSON.stringify(name)}`;
          }
          const value = node.value?.value;
          if (value !== undefined && value !== null && value !== "" && String(value) !== name) {
            line += `: ${JSON.stringify(clip(String(value)))}`;
          }
          for (const flag of PROPERTY_FLAGS) {
            const flag_value = props.get(flag);
            if (flag_value === undefined || flag_value === false || flag_value === "false") {
              continue;
            }
            line += flag_value === true ? ` [${flag}]` : ` [${flag}=${String(flag_value)}]`;
          }
          if ((interactive || role === "Iframe" || role === "iframe") && node.backendDOMNodeId) {
            counter += 1;
            const ref = `e${counter}`;
            refs.set(ref, {
              backendNodeId: node.backendDOMNodeId,
              sessionId: frame.sessionId,
              targetId: frame.targetId,
              role,
              name,
            });
            line += ` [ref=${ref}]`;
          }
          lines.push(line);
          printed = true;
          next_depth = depth + 1;
        }
      }

      for (const child_id of node.childIds ?? []) {
        const child = by_id.get(child_id);
        if (child) {
          visit(child, next_depth, printed ? name : parent_name);
        }
      }

      if (node.backendDOMNodeId) {
        for (const child_frame of children_frames.get(frame_key(frame.sessionId, node.backendDOMNodeId)) ?? []) {
          render_frame(child_frame, next_depth);
        }
      }
    };

    for (const root of roots) {
      visit(root, depth, "");
    }
  };

  if (main) {
    render_frame(main, 0);
  }
  // Frames whose host could not be matched still get rendered, at the end.
  for (const frame of frames.slice(1)) {
    // (Blank helper frames, e.g. about:blank sandboxes, carry nothing useful.)
    if (!rendered_frames.has(frame) && frame.url !== "about:blank" && frame.url !== "") {
      lines.push(`- iframe ${JSON.stringify(frame.url ?? "")}`);
      render_frame(frame, 1);
    }
  }

  return { text: lines.join("\n"), refs };
}
