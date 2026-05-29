import { useState, useRef } from "react";

const SYSTEM_PROMPT = `RESPONDE ÚNICAMENTE CON JSON PURO. Primer carácter: {. Último carácter: }. Cero texto antes o después.

ROL: Monitor regulatorio CREG Colombia. Solo español. Nunca inventes números de documentos.

ENTRADA: {"Tipos":[],"Rango":["YYYY-MM-DD","YYYY-MM-DD"],"Areas":[],"Relevancia_min":1}
Si inválido: {"error":"JSON inválido","campos_faltantes":[]}

BÚSQUEDA: Tiempo real en creg.gov.co → gestornormativo.creg.gov.co → minenergia.gov.co → diario-oficial.vlex.com.co. Omite no verificados, derogados o fuera de filtros. Si el JSON se aproxima al límite de tokens, cierra el array y el objeto correctamente antes de truncar.

SCHEMA: {"rango_de_fechas":["YYYY-MM-DD","YYYY-MM-DD"],"total_documentos":N,"fuentes_consultadas":["url"],"info":"vacío o explicación si <6 docs","documentos":[{"numero_nombre":"str","fecha":"YYYY-MM-DD","tipo":"Resolución|Circular|Acuerdo","area":"str","relevancia":1,"confianza":"alta|media|baja","url_oficial":"https://","modifica_a":["str"],"descripcion":"str"}],"proyectos_en_consulta":[{"numero_nombre":"str","fecha":"YYYY-MM-DD","area":"str","url_oficial":"https://","descripcion":"str"}]}

REGLAS: total_documentos=len(documentos). confianza: alta=URL directa, media=referencia verificada, baja=fuente secundaria. Mínimo 6 documentos verificados.`

const TIPOS = ["Resolución", "Circular", "Acuerdo"];
const AREAS = [
  "Tarifas de energía","Gas natural","Energías renovables",
  "Mercado mayorista","Distribución eléctrica","GNL",
  "Subsidios","Redes inteligentes","Autogeneración","STN / Transporte"
];

const RELEVANCIA_COLOR = {
  5: { bg: "#EAF3DE", text: "#3B6D11", label: "Muy alta" },
  4: { bg: "#E6F1FB", text: "#185FA5", label: "Alta" },
  3: { bg: "#FAEEDA", text: "#854F0B", label: "Media" },
  2: { bg: "#FAECE7", text: "#993C1D", label: "Baja" },
  1: { bg: "#F1EFE8", text: "#5F5E5A", label: "Mínima" },
};
const CONFIANZA_COLOR = {
  alta:  { bg: "#EAF3DE", text: "#3B6D11" },
  media: { bg: "#FAEEDA", text: "#854F0B" },
  baja:  { bg: "#FAECE7", text: "#993C1D" },
};

const today = new Date().toISOString().split("T")[0];
const sixMonthsAgo = new Date(Date.now() - 180*24*60*60*1000).toISOString().split("T")[0];

export default function CREGMonitor() {
  const [tipos, setTipos] = useState(["Resolución","Circular","Acuerdo"]);
  const [areas, setAreas] = useState([...AREAS]);
  const [rango, setRango] = useState([sixMonthsAgo, today]);
  const [relevanciaMin, setRelevanciaMin] = useState(1);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [rawResp, setRawResp] = useState(null);
  const [textBlock, setTextBlock] = useState(null);
  const [activeTab, setActiveTab] = useState("documentos");
  const [sortField, setSortField] = useState("relevancia");
  const [sortDir, setSortDir] = useState("desc");
  const [filterArea, setFilterArea] = useState("Todas");
  const [filterTipo, setFilterTipo] = useState("Todos");
  const abortRef = useRef(null);

  const toggleTipo = (t) =>
    setTipos(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t]);
  const toggleArea = (a) =>
    setAreas(p => p.includes(a) ? p.filter(x => x !== a) : [...p, a]);
  const toggleAllAreas = () =>
    setAreas(areas.length === AREAS.length ? [] : [...AREAS]);

  const buildJSON = () => ({
    Tipos: tipos,
    Rango: rango,
    Areas: areas,
    Relevancia_min: relevanciaMin,
  });

  const handleSearch = async () => {
    if (!tipos.length || !areas.length) {
      setError("Selecciona al menos un tipo y un área.");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setRawResp(null);
    setTextBlock(null);
    abortRef.current = new AbortController();
    let rawText = null;

    try {
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: abortRef.current.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: JSON.stringify(buildJSON()) }],
        }),
      });
      rawText = await resp.text();
      const data = JSON.parse(rawText);
      const textBlock = data.content?.find(b => b.type === "text");
      if (!textBlock) throw new Error("Sin bloque de texto en la respuesta");
      setTextBlock(textBlock.text);
      const raw = textBlock.text;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No se encontró JSON en la respuesta");
      const parsed = JSON.parse(jsonMatch[0]);
      setResult(parsed);
      setActiveTab("documentos");
      setFilterArea("Todas");
      setFilterTipo("Todos");
    } catch (e) {
      if (e.name !== "AbortError") {
        setError("Error al procesar la respuesta: " + e.message);
        if (rawText) setRawResp(rawText);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  const sortedDocs = () => {
    if (!result?.documentos) return [];
    return [...result.documentos]
      .filter(d => filterArea === "Todas" || d.area === filterArea)
      .filter(d => filterTipo === "Todos" || d.tipo === filterTipo)
      .sort((a, b) => {
        const va = a[sortField] ?? "";
        const vb = b[sortField] ?? "";
        const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
        return sortDir === "asc" ? cmp : -cmp;
      });
  };

  const handleSort = (field) => {
    if (sortField === field) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(field); setSortDir("desc"); }
  };

  const pill = (text, colors) => (
    <span style={{
      background: colors.bg, color: colors.text,
      fontSize: 11, padding: "2px 8px",
      borderRadius: 99, whiteSpace: "nowrap", fontWeight: 500,
    }}>{text}</span>
  );

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <span style={{ opacity: 0.3, fontSize: 10 }}>⇅</span>;
    return <span style={{ fontSize: 10 }}>{sortDir === "asc" ? "↑" : "↓"}</span>;
  };

  const th = (label, field, w) => (
    <th onClick={() => handleSort(field)} style={{
      padding: "8px 10px", textAlign: "left", fontSize: 12,
      fontWeight: 500, color: "var(--color-text-secondary)",
      cursor: "pointer", userSelect: "none", width: w,
      borderBottom: "0.5px solid var(--color-border-tertiary)",
      whiteSpace: "nowrap",
    }}>
      {label} <SortIcon field={field} />
    </th>
  );

  const uniqueAreas = result?.documentos ? [...new Set(result.documentos.map(d => d.area))] : [];
  const uniqueTipos = result?.documentos ? [...new Set(result.documentos.map(d => d.tipo))] : [];

  return (
    <div style={{ fontFamily: "var(--font-sans)", padding: "1rem 0" }}>
      <h2 style={{ fontSize: 18, fontWeight: 500, margin: "0 0 4px", color: "var(--color-text-primary)" }}>
        Monitor regulatorio CREG
      </h2>
      <p style={{ fontSize: 13, color: "var(--color-text-secondary)", margin: "0 0 1.5rem" }}>
        Configura los filtros y consulta documentos vigentes de la CREG en tiempo real.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        {/* Tipos */}
        <div style={{
          background: "var(--color-background-primary)",
          border: "0.5px solid var(--color-border-tertiary)",
          borderRadius: "var(--border-radius-lg)", padding: "14px 16px",
        }}>
          <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Tipos de documento
          </p>
          {TIPOS.map(t => (
            <label key={t} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={tipos.includes(t)} onChange={() => toggleTipo(t)}
                style={{ width: 15, height: 15, accentColor: "var(--color-text-info)", cursor: "pointer" }} />
              <span style={{ fontSize: 14, color: "var(--color-text-primary)" }}>{t}</span>
            </label>
          ))}
        </div>

        {/* Rango + Relevancia */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{
            background: "var(--color-background-primary)",
            border: "0.5px solid var(--color-border-tertiary)",
            borderRadius: "var(--border-radius-lg)", padding: "14px 16px", flex: 1,
          }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Rango de fechas
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[["Desde", 0], ["Hasta", 1]].map(([label, i]) => (
                <label key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, color: "var(--color-text-secondary)", width: 40 }}>{label}</span>
                  <input type="date" value={rango[i]}
                    onChange={e => setRango(r => i === 0 ? [e.target.value, r[1]] : [r[0], e.target.value])}
                    style={{ flex: 1, fontSize: 13, padding: "4px 8px",
                      border: "0.5px solid var(--color-border-tertiary)",
                      borderRadius: "var(--border-radius-md)",
                      background: "var(--color-background-secondary)",
                      color: "var(--color-text-primary)" }} />
                </label>
              ))}
            </div>
          </div>
          <div style={{
            background: "var(--color-background-primary)",
            border: "0.5px solid var(--color-border-tertiary)",
            borderRadius: "var(--border-radius-lg)", padding: "14px 16px",
          }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Relevancia mínima
            </p>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input type="range" min={1} max={5} step={1} value={relevanciaMin}
                onChange={e => setRelevanciaMin(Number(e.target.value))}
                style={{ flex: 1, accentColor: "var(--color-text-info)" }} />
              <span style={{ fontSize: 14, fontWeight: 500, minWidth: 24, color: "var(--color-text-primary)" }}>
                {relevanciaMin}
              </span>
              {pill(RELEVANCIA_COLOR[relevanciaMin]?.label, RELEVANCIA_COLOR[relevanciaMin] ?? {})}
            </div>
          </div>
        </div>
      </div>

      {/* Áreas */}
      <div style={{
        background: "var(--color-background-primary)",
        border: "0.5px solid var(--color-border-tertiary)",
        borderRadius: "var(--border-radius-lg)", padding: "14px 16px", marginBottom: 14,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", margin: 0, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Áreas temáticas
          </p>
          <button onClick={toggleAllAreas} style={{
            fontSize: 12, padding: "3px 10px", cursor: "pointer",
            border: "0.5px solid var(--color-border-secondary)",
            borderRadius: "var(--border-radius-md)",
            background: "transparent", color: "var(--color-text-secondary)",
          }}>
            {areas.length === AREAS.length ? "Desmarcar todo" : "Seleccionar todo"}
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "6px 16px" }}>
          {AREAS.map(a => (
            <label key={a} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={areas.includes(a)} onChange={() => toggleArea(a)}
                style={{ width: 14, height: 14, accentColor: "var(--color-text-info)", cursor: "pointer" }} />
              <span style={{ fontSize: 13, color: "var(--color-text-primary)" }}>{a}</span>
            </label>
          ))}
        </div>
      </div>

      {/* JSON preview + botón */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 16 }}>
        <div style={{
          flex: 1, background: "var(--color-background-secondary)",
          border: "0.5px solid var(--color-border-tertiary)",
          borderRadius: "var(--border-radius-md)", padding: "10px 14px",
          fontFamily: "var(--font-mono)", fontSize: 12,
          color: "var(--color-text-secondary)", whiteSpace: "pre-wrap", wordBreak: "break-all",
        }}>
          {JSON.stringify(buildJSON(), null, 2)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={loading ? handleStop : handleSearch}
            disabled={!tipos.length || !areas.length}
            style={{
              padding: "10px 20px", fontSize: 14, fontWeight: 500,
              borderRadius: "var(--border-radius-md)", cursor: "pointer",
              border: "0.5px solid var(--color-border-secondary)",
              background: loading ? "var(--color-background-danger)" : "var(--color-background-info)",
              color: loading ? "var(--color-text-danger)" : "var(--color-text-info)",
              whiteSpace: "nowrap",
            }}>
            {loading ? "⏹ Detener" : "Consultar →"}
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          background: "var(--color-background-danger)",
          border: "0.5px solid var(--color-border-danger)",
          borderRadius: "var(--border-radius-md)", padding: "10px 14px",
          fontSize: 13, color: "var(--color-text-danger)", marginBottom: 8,
        }}>{error}</div>
      )}
      {rawResp && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>
              Debug — respuesta cruda de la API ({rawResp.length} caracteres)
            </span>
            <button onClick={() => setRawResp(null)} style={{
              fontSize: 11, padding: "2px 8px", cursor: "pointer",
              border: "0.5px solid var(--color-border-tertiary)",
              borderRadius: "var(--border-radius-md)",
              background: "transparent", color: "var(--color-text-secondary)",
            }}>Cerrar</button>
          </div>
          <pre style={{
            background: "var(--color-background-secondary)",
            border: "0.5px solid var(--color-border-tertiary)",
            borderRadius: "var(--border-radius-md)", padding: "10px 14px",
            fontFamily: "var(--font-mono)", fontSize: 11,
            color: "var(--color-text-secondary)", whiteSpace: "pre-wrap",
            wordBreak: "break-all", maxHeight: 320, overflowY: "auto", margin: 0,
          }}>{rawResp}</pre>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: "center", padding: "2rem 0", color: "var(--color-text-secondary)", fontSize: 14 }}>
          <div style={{ marginBottom: 8, fontSize: 22 }}>⏳</div>
          Buscando en fuentes CREG en tiempo real...
        </div>
      )}

      {result && (
        <div>
          {/* Métricas */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
            {[
              ["Documentos", result.total_documentos ?? result.documentos?.length ?? 0],
              ["Proyectos", result.proyectos_en_consulta?.length ?? 0],
              ["Fuentes", result.fuentes_consultadas?.length ?? 0],
              ["Rango", result.rango_de_fechas ? result.rango_de_fechas.join(" / ") : "—"],
            ].map(([label, val]) => (
              <div key={label} style={{
                background: "var(--color-background-secondary)",
                borderRadius: "var(--border-radius-md)", padding: "10px 14px",
              }}>
                <p style={{ fontSize: 12, color: "var(--color-text-secondary)", margin: "0 0 4px" }}>{label}</p>
                <p style={{ fontSize: 20, fontWeight: 500, margin: 0, color: "var(--color-text-primary)" }}>{val}</p>
              </div>
            ))}
          </div>

          {result.info && (
            <div style={{
              background: "var(--color-background-warning)",
              border: "0.5px solid var(--color-border-warning)",
              borderRadius: "var(--border-radius-md)", padding: "10px 14px",
              fontSize: 13, color: "var(--color-text-warning)", marginBottom: 12,
            }}>
              ⚠ {result.info}
            </div>
          )}

          {/* Tabs */}
          <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
            {[["documentos", `Documentos (${result.documentos?.length ?? 0})`],
              ["proyectos", `Proyectos en consulta (${result.proyectos_en_consulta?.length ?? 0})`],
              ["fuentes", "Fuentes consultadas"]].map(([key, label]) => (
              <button key={key} onClick={() => setActiveTab(key)} style={{
                fontSize: 13, padding: "6px 14px", cursor: "pointer", border: "none",
                borderBottom: activeTab === key ? "2px solid var(--color-text-info)" : "2px solid transparent",
                background: "transparent",
                color: activeTab === key ? "var(--color-text-info)" : "var(--color-text-secondary)",
                fontWeight: activeTab === key ? 500 : 400,
              }}>{label}</button>
            ))}
          </div>

          {activeTab === "documentos" && (
            <div>
              {/* Filtros inline */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                <select value={filterArea} onChange={e => setFilterArea(e.target.value)}
                  style={{ fontSize: 13, padding: "4px 8px", borderRadius: "var(--border-radius-md)",
                    border: "0.5px solid var(--color-border-tertiary)",
                    background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }}>
                  <option>Todas</option>
                  {uniqueAreas.map(a => <option key={a}>{a}</option>)}
                </select>
                <select value={filterTipo} onChange={e => setFilterTipo(e.target.value)}
                  style={{ fontSize: 13, padding: "4px 8px", borderRadius: "var(--border-radius-md)",
                    border: "0.5px solid var(--color-border-tertiary)",
                    background: "var(--color-background-secondary)", color: "var(--color-text-primary)" }}>
                  <option>Todos</option>
                  {uniqueTipos.map(t => <option key={t}>{t}</option>)}
                </select>
                <span style={{ fontSize: 12, color: "var(--color-text-secondary)", alignSelf: "center" }}>
                  {sortedDocs().length} resultado{sortedDocs().length !== 1 ? "s" : ""}
                </span>
              </div>

              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
                  <thead>
                    <tr style={{ background: "var(--color-background-secondary)" }}>
                      {th("Documento", "numero_nombre", "28%")}
                      {th("Fecha", "fecha", "9%")}
                      {th("Tipo", "tipo", "10%")}
                      {th("Área", "area", "14%")}
                      {th("Relev.", "relevancia", "7%")}
                      {th("Confianza", "confianza", "8%")}
                      <th style={{ padding: "8px 10px", fontSize: 12, fontWeight: 500,
                        color: "var(--color-text-secondary)", width: "24%",
                        borderBottom: "0.5px solid var(--color-border-tertiary)" }}>Descripción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDocs().map((doc, i) => (
                      <tr key={i} style={{
                        borderBottom: "0.5px solid var(--color-border-tertiary)",
                        background: i % 2 === 0 ? "transparent" : "var(--color-background-secondary)",
                      }}>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          {doc.url_oficial && doc.url_oficial !== "https://" ? (
                            <a href={doc.url_oficial} style={{ color: "var(--color-text-info)", textDecoration: "none", fontWeight: 500, fontSize: 12 }}>
                              {doc.numero_nombre}
                            </a>
                          ) : (
                            <span style={{ fontWeight: 500, fontSize: 12 }}>{doc.numero_nombre}</span>
                          )}
                          {doc.modifica_a?.length > 0 && (
                            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>
                              Modifica: {doc.modifica_a.join(", ")}
                            </div>
                          )}
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", fontSize: 12, color: "var(--color-text-secondary)", whiteSpace: "nowrap" }}>
                          {doc.fecha}
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 99,
                            background: "var(--color-background-secondary)",
                            border: "0.5px solid var(--color-border-tertiary)",
                            color: "var(--color-text-secondary)" }}>{doc.tipo}</span>
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", fontSize: 12, color: "var(--color-text-secondary)" }}>
                          {doc.area}
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          {pill(doc.relevancia, RELEVANCIA_COLOR[doc.relevancia] ?? RELEVANCIA_COLOR[1])}
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          {pill(doc.confianza, CONFIANZA_COLOR[doc.confianza?.split("=")[0]] ?? CONFIANZA_COLOR.baja)}
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>
                          {doc.descripcion}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {sortedDocs().length === 0 && (
                  <p style={{ textAlign: "center", color: "var(--color-text-tertiary)", padding: "2rem", fontSize: 13 }}>
                    No hay documentos con los filtros actuales.
                  </p>
                )}
              </div>
            </div>
          )}

          {activeTab === "proyectos" && (
            <div>
              {result.proyectos_en_consulta?.length > 0 ? (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "var(--color-background-secondary)" }}>
                      {[["Proyecto", "34%"], ["Fecha", "11%"], ["Área", "17%"], ["Descripción", "38%"]].map(([h, w]) => (
                        <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontSize: 12,
                          fontWeight: 500, color: "var(--color-text-secondary)", width: w,
                          borderBottom: "0.5px solid var(--color-border-tertiary)" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.proyectos_en_consulta.map((p, i) => (
                      <tr key={i} style={{ borderBottom: "0.5px solid var(--color-border-tertiary)",
                        background: i % 2 === 0 ? "transparent" : "var(--color-background-secondary)" }}>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          {p.url_oficial ? (
                            <a href={p.url_oficial} style={{ color: "var(--color-text-info)", textDecoration: "none", fontWeight: 500, fontSize: 12 }}>
                              {p.numero_nombre}
                            </a>
                          ) : <span style={{ fontWeight: 500, fontSize: 12 }}>{p.numero_nombre}</span>}
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", fontSize: 12, color: "var(--color-text-secondary)" }}>{p.fecha}</td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", fontSize: 12, color: "var(--color-text-secondary)" }}>{p.area}</td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.5 }}>{p.descripcion}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p style={{ textAlign: "center", color: "var(--color-text-tertiary)", padding: "2rem", fontSize: 13 }}>
                  No se encontraron proyectos en consulta para estos filtros.
                </p>
              )}
            </div>
          )}

          {activeTab === "fuentes" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {result.fuentes_consultadas?.map((url, i) => (
                <a key={i} href={url} style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 14px",
                  background: "var(--color-background-secondary)",
                  border: "0.5px solid var(--color-border-tertiary)",
                  borderRadius: "var(--border-radius-md)",
                  color: "var(--color-text-info)", textDecoration: "none", fontSize: 13,
                }}>
                  <i className="ti ti-external-link" style={{ fontSize: 16 }} aria-hidden="true" />
                  {url}
                </a>
              ))}
            </div>
          )}
        </div>
      )}

      {textBlock && (
        <div style={{ marginTop: 24 }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            marginBottom: 6,
          }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>
              JSON devuelto por la API — textBlock.text ({textBlock.length} caracteres)
            </span>
            <button onClick={() => setTextBlock(null)} style={{
              fontSize: 11, padding: "2px 8px", cursor: "pointer",
              border: "0.5px solid var(--color-border-tertiary)",
              borderRadius: "var(--border-radius-md)",
              background: "transparent", color: "var(--color-text-secondary)",
            }}>Cerrar</button>
          </div>
          <pre style={{
            background: "var(--color-background-secondary)",
            border: "0.5px solid var(--color-border-tertiary)",
            borderRadius: "var(--border-radius-md)", padding: "12px 14px",
            fontFamily: "var(--font-mono)", fontSize: 11,
            color: "var(--color-text-secondary)", whiteSpace: "pre-wrap",
            wordBreak: "break-all", maxHeight: 400, overflowY: "auto", margin: 0,
          }}>{textBlock}</pre>
        </div>
      )}
    </div>
  );
}
