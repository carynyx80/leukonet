/** Visual identity of each sentinel. `hue` is the name of a CSS token. */
export interface AgentInfo {
  name: string;
  title: string;
  catches: string;
  hue: string;
  /** Which transaction kinds flow to this agent on the map. */
  eats: string[];
}

export const AGENTS: AgentInfo[] = [
  { name: "neutrophil", title: "First responder", catches: "Drainers · hijacked keys", hue: "a-neutrophil", eats: ["Transfer", "AddKey"] },
  { name: "macrophage", title: "Contract inspector", catches: "Scam contracts", hue: "a-macrophage", eats: ["DeployContract"] },
  { name: "nk-cell", title: "Agent watcher", catches: "Rogue AI agents", hue: "a-nk", eats: ["Transfer"] },
  { name: "t-helper", title: "Name guard · coordinator", catches: "Look-alike names", hue: "a-thelper", eats: ["CreateAccount"] },
  { name: "b-cell", title: "The sceptic · memory", catches: "Double-checks everyone", hue: "a-bcell", eats: ["FunctionCall", "DeleteKey", "DeleteAccount", "Other"] },
];

export const agentByName = (n: string) => AGENTS.find((a) => a.name === n);

/** Cell-shaped glyphs, drawn in a 32×32 box. `c` is the agent colour. */
export function glyph(name: string, c: string, bg = "#0e1116"): string {
  const body = `<circle cx="16" cy="16" r="13" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-width="2"/>`;
  const inner: Record<string, string> = {
    // multi-lobed nucleus
    neutrophil: `<g fill="${c}"><circle cx="11.5" cy="14" r="3.6"/><circle cx="17" cy="11.5" r="3.4"/><circle cx="20.5" cy="17.5" r="3.6"/><circle cx="14.5" cy="20" r="3"/></g>`,
    // blob reaching out with pseudopods
    macrophage: `<path d="M9 13c1-4 6-6 9-4 3-2 7 1 6 5 3 2 2 7-2 7-1 3-6 4-8 1-4 1-7-3-5-6-2-1-1-3 0-3z" fill="${c}" fill-opacity=".85"/><circle cx="14" cy="15" r="1.4" fill="${bg}"/><circle cx="19" cy="17" r="1.1" fill="${bg}"/>`,
    // granules
    "nk-cell": `<circle cx="16" cy="16" r="5" fill="${c}"/><g fill="${c}"><circle cx="9" cy="11" r="1.6"/><circle cx="23" cy="10" r="1.6"/><circle cx="24" cy="20" r="1.6"/><circle cx="9.5" cy="21.5" r="1.6"/><circle cx="16" cy="7.5" r="1.3"/><circle cx="16" cy="24.5" r="1.3"/></g>`,
    // receptors around the edge
    "t-helper": `<circle cx="16" cy="16" r="5.5" fill="${c}"/><g stroke="${c}" stroke-width="2" stroke-linecap="round"><path d="M16 3v4M16 25v4M3 16h4M25 16h4M7 7l2.8 2.8M22.2 22.2 25 25M7 25l2.8-2.8M22.2 9.8 25 7"/></g>`,
    // an antibody: the Y
    "b-cell": `<g stroke="${c}" stroke-width="2.6" stroke-linecap="round" fill="none"><path d="M16 24V16M16 16l-6-7M16 16l6-7"/></g><g fill="${c}"><circle cx="9.5" cy="8.5" r="2"/><circle cx="22.5" cy="8.5" r="2"/></g>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}${inner[name] ?? ""}</svg>`;
}
