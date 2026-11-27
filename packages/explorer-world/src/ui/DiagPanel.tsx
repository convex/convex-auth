import { useEffect, useState } from "react";
import { LAYERS, useDiag, type LayerName } from "../diag.ts";
import { diagLive } from "../scene/Diagnostics.tsx";

const EFFECTS = ["sanitize", "bloom", "vignette", "fog"] as const;

/**
 * `?diag`: what the GPU is, how the scene buffer looks, and a switch for each
 * effect and layer, so that one screenshot says where a problem is.
 */
export function DiagPanel() {
  const diag = useDiag();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!diag.open) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [diag.open]);
  if (!diag.open) return null;
  const scan = diag.scan;
  return (
    <div className="diag panel" data-testid="diag">
      <h3>Diagnostics</h3>
      <h4>Scene buffer, before effects</h4>
      {scan ? (
        <p className={scan.nonFinite ? "bad" : "good"}>
          {scan.nonFinite} non-finite, {scan.negative} negative, {scan.huge}{" "}
          above 64 of {scan.width}×{scan.height} ({scan.type} floats, half
          resolution); range {scan.min.toFixed(3)} to {scan.max.toFixed(2)}
          {scan.box
            ? `; non-finite within x ${scan.box[0]}–${scan.box[2]}, y ${scan.box[1]}–${scan.box[3]}`
            : ""}
        </p>
      ) : (
        <p>scanning…</p>
      )}
      <h4>Effects</h4>
      <div className="switches">
        {EFFECTS.map((k) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={diag[k]}
              onChange={() => diag.toggle(k)}
            />
            {k}
          </label>
        ))}
      </div>
      <h4>Layers</h4>
      <div className="switches">
        {LAYERS.map((k: LayerName) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={diag.layers[k]}
              onChange={() => diag.toggle(k)}
            />
            {k}
          </label>
        ))}
      </div>
      <h4>GPU, canvas, camera</h4>
      <dl>
        {Object.entries(diagLive.info).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        <div>
          <dt>canvas</dt>
          <dd>{diagLive.canvas}</dd>
        </div>
        <div>
          <dt>camera</dt>
          <dd>{diagLive.camera}</dd>
        </div>
      </dl>
    </div>
  );
}
