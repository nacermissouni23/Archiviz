import mermaid from 'mermaid';

let initialized = false;

export function ensureMermaid() {
  if (!initialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: 'dark',
      securityLevel: 'loose',
      flowchart: { curve: 'basis', padding: 16, htmlLabels: true, wrappingWidth: 260 },
    });
    initialized = true;
  }
}

/** Render mermaid code to an SVG string; throws on invalid code. */
export function renderMermaid(idPrefix: string, code: string): Promise<string> {
  ensureMermaid();
  return mermaid.render(`${idPrefix}${Date.now()}${Math.random().toString(36).slice(2, 6)}`, code).then((r) => r.svg);
}

/** Attach a click handler to every rendered node; handler receives the node label text. */
export function wireNodeClicks(
  container: HTMLElement,
  onNode: (label: string) => void
) {
  container.querySelectorAll('g.node').forEach((n) => {
    (n as SVGElement).style.cursor = 'pointer';
    n.addEventListener('click', () => {
      const label = (n as HTMLElement)
        .querySelector('.nodeLabel, foreignObject div')
        ?.textContent?.trim();
      if (label) onNode(label);
    });
  });
}
