import { mountFinishButton } from "../util/finish_step.js";
// Scene 7 — Architecture (Hashtopolis sidecar).
//
// Static diagram. Same blocks as wiki/architecture.md but drawn so a
// new reader can pick it up cold.

export const name = "architecture";

export async function render(mount) {
  mount.innerHTML = `
    <div class="panel">
      <!-- Brand intro video — autoplays muted (browsers block sound-on-load
           autoplay unless the user has interacted, so muted-loop is the
           safe default). Loops, no controls. Click to toggle sound. -->
      <video class="arch-intro" autoplay loop muted playsinline
             title="click to toggle sound"
             onclick="this.muted = !this.muted;">
        <source src="/assets/narwal.mp4" type="video/mp4"/>
      </video>

      <h2>Architecture</h2>
      <div class="sub">
        Narwal lives next to Hashtopolis in the same dev container but
        doesn't fork it. The bridge talks to upstream's REST API, so upstream
        updates don't carry diffs. Simulation uses hashcat-stdout for fast
        interactive feedback; PCFG / OMEN run async for the headline
        guess-number curves.
      </div>

      <style>
        .arch-intro {
          display: block;
          width: 100%;
          max-height: 360px;
          object-fit: cover;
          border-radius: var(--radius-md);
          margin: 0 0 18px;
          background: var(--surface-2);
          cursor: pointer;
        }
      </style>
      <svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" width="100%" role="img" aria-label="architecture diagram">
        <defs>
          <marker id="arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M2 1L8 5L2 9" fill="none" stroke="var(--text-secondary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </marker>
        </defs>
        <rect x="20" y="30" width="720" height="430" rx="20" fill="var(--surface-2)" stroke="var(--border)" stroke-width="0.5"/>
        <text x="40" y="60" font-size="14" font-weight="500" fill="var(--text)">Hashtopolis devcontainer</text>
        <text x="40" y="78" font-size="11" fill="var(--text-secondary)">docker compose · existing dev setup</text>

        <rect x="40" y="100" width="328" height="100" rx="10" fill="var(--info-bg)" stroke="var(--info-border)" stroke-width="0.5"/>
        <text x="204" y="128" text-anchor="middle" font-size="13" font-weight="500" fill="var(--info-text)">Narwal web UI</text>
        <text x="204" y="148" text-anchor="middle" font-size="11" fill="var(--info-text)">single-page · Chart.js · vanilla JS</text>
        <text x="204" y="166" text-anchor="middle" font-size="11" fill="var(--info-text)">setup · composer · coverage · heatmap · overlap</text>
        <text x="204" y="184" text-anchor="middle" font-size="11" fill="var(--info-text)">cluster · verdict · architecture</text>

        <rect x="392" y="100" width="328" height="100" rx="10" fill="var(--mask-bg)" stroke="var(--mask-border)" stroke-width="0.5"/>
        <text x="556" y="128" text-anchor="middle" font-size="13" font-weight="500" fill="var(--mask-text)">Hashtopolis web UI</text>
        <text x="556" y="148" text-anchor="middle" font-size="11" fill="var(--mask-text)">untouched · upstream</text>
        <text x="556" y="166" text-anchor="middle" font-size="11" fill="var(--mask-text)">receives the generated plan</text>

        <line x1="204" y1="200" x2="204" y2="232" stroke="var(--text-secondary)" stroke-width="1" marker-end="url(#arr)"/>
        <rect x="40" y="236" width="328" height="120" rx="10" fill="var(--success-bg)" stroke="var(--success-border)" stroke-width="0.5"/>
        <text x="204" y="264" text-anchor="middle" font-size="13" font-weight="500" fill="var(--success-text)">FastAPI backend</text>
        <text x="204" y="284" text-anchor="middle" font-size="11" fill="var(--success-text)">plan = compose(target, refs, cluster)</text>
        <text x="204" y="302" text-anchor="middle" font-size="11" fill="var(--success-text)">caches cleaned corpora + sim hits + UMAP</text>
        <text x="204" y="320" text-anchor="middle" font-size="11" fill="var(--success-text)">pre-warms at startup → instant Scene 3</text>
        <text x="204" y="338" text-anchor="middle" font-size="11" fill="var(--success-text)">11 unit + integration tests</text>

        <line x1="368" y1="296" x2="390" y2="296" stroke="var(--text-secondary)" stroke-width="1" marker-end="url(#arr)"/>
        <text x="379" y="288" text-anchor="middle" font-size="9" fill="var(--text-secondary)">JSON</text>
        <rect x="392" y="236" width="328" height="120" rx="10" fill="var(--warning-bg)" stroke="var(--warning-border)" stroke-width="0.5"/>
        <text x="556" y="264" text-anchor="middle" font-size="13" font-weight="500" fill="var(--warning-text)">Hashtopolis API bridge</text>
        <text x="556" y="284" text-anchor="middle" font-size="11" fill="var(--warning-text)">REST calls · upstream API</text>
        <text x="556" y="302" text-anchor="middle" font-size="11" fill="var(--warning-text)">preview JSON now · live POST later</text>
        <text x="556" y="320" text-anchor="middle" font-size="11" fill="var(--warning-text)">no fork · sidecar only</text>

        <rect x="40" y="380" width="120" height="60" rx="10" fill="var(--success-bg)" stroke="var(--success-border)" stroke-width="0.5"/>
        <text x="100" y="404" text-anchor="middle" font-size="13" font-weight="500" fill="var(--success-text)">demeuk</text>
        <text x="100" y="420" text-anchor="middle" font-size="11" fill="var(--success-text)">NFI cleaner</text>

        <rect x="172" y="380" width="132" height="60" rx="10" fill="var(--success-bg)" stroke="var(--success-border)" stroke-width="0.5"/>
        <text x="238" y="404" text-anchor="middle" font-size="13" font-weight="500" fill="var(--success-text)">hashcat --stdout</text>
        <text x="238" y="420" text-anchor="middle" font-size="11" fill="var(--success-text)">candidate gen</text>

        <rect x="316" y="380" width="132" height="60" rx="10" fill="var(--success-bg)" stroke="var(--success-border)" stroke-width="0.5"/>
        <text x="382" y="404" text-anchor="middle" font-size="13" font-weight="500" fill="var(--success-text)">umap-learn</text>
        <text x="382" y="420" text-anchor="middle" font-size="11" fill="var(--success-text)">dataset cluster</text>

        <rect x="460" y="380" width="132" height="60" rx="10" fill="var(--warning-bg)" stroke="var(--warning-border)" stroke-width="0.5"/>
        <text x="526" y="404" text-anchor="middle" font-size="13" font-weight="500" fill="var(--warning-text)">PCFG · OMEN</text>
        <text x="526" y="420" text-anchor="middle" font-size="11" fill="var(--warning-text)">guess-number (stretch)</text>

        <rect x="604" y="380" width="118" height="60" rx="10" fill="var(--warning-bg)" stroke="var(--warning-border)" stroke-width="0.5"/>
        <text x="663" y="404" text-anchor="middle" font-size="13" font-weight="500" fill="var(--warning-text)">datasketch</text>
        <text x="663" y="420" text-anchor="middle" font-size="11" fill="var(--warning-text)">MinHash · Jaccard</text>
      </svg>
      <div class="note">
        Sidecar over fork. Upstream Hashtopolis moves; our diffs don't have
        to. If something belongs upstream, we send a PR.
      </div>

      <!-- Glossary — low-emphasis definition list. Lives here rather than
           as a banner on home so the landing page stays focused on the
           workflow, not on jargon. -->
      <div class="arch-glossary">
        <h3>Glossary</h3>
        <dl>
          <dt>household-day</dt>
          <dd>
            How Narwal reports savings — one number, one unit. Each plan is
            translated into <strong>household-days</strong>: the electricity
            an average Dutch home consumes in 24&nbsp;hours (≈10&nbsp;kWh).
            One full day on the cluster ≈ <strong>9&nbsp;household-days</strong>;
            a clever 2-hour plan can save ~0.7&nbsp;household-days.
          </dd>
          <dt>cluster</dt>
          <dd>
            Default reference rig in the planner.
            <code>8× RTX&nbsp;4090 ≈ 3.6&nbsp;kW</code> sustained → ≈ 86&nbsp;kWh
            per cluster-day.
          </dd>
          <dt>plan-only</dt>
          <dd>
            Narwal never attempts the user's target hashes itself. Simulation
            runs against the reference corpora; <strong>Hashtopolis cracks</strong>
            the real target.
          </dd>
        </dl>
      </div>

      <style>
        .arch-glossary {
          margin-top: 22px; padding-top: 18px;
          border-top: 1px dashed var(--border);
        }
        .arch-glossary h3 {
          margin: 0 0 10px; font-size: 12px; font-weight: 600;
          letter-spacing: 0.4px; text-transform: uppercase;
          color: var(--text-tertiary);
        }
        .arch-glossary dl {
          margin: 0;
          display: grid; grid-template-columns: 180px 1fr; gap: 8px 18px;
          font-size: 13px; line-height: 1.55;
        }
        .arch-glossary dt {
          color: var(--text-secondary);
          font-variant: small-caps; letter-spacing: 0.3px;
        }
        .arch-glossary dd { margin: 0; color: var(--text-secondary); }
        .arch-glossary dd strong { color: var(--text); }
        .arch-glossary dd code {
          font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 12px;
          background: var(--surface-2); padding: 1px 5px; border-radius: 3px;
        }
        @media (max-width: 640px) {
          .arch-glossary dl { grid-template-columns: 1fr; gap: 4px 0; }
          .arch-glossary dt { margin-top: 8px; color: var(--text); }
        }
      </style>
    </div>
  `;
  mountFinishButton(mount, { sceneId: "architecture", label: "Architecture" });
}
