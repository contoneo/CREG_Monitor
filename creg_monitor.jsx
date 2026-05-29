import { useState, useRef } from "react";
import { createRoot } from 'react-dom/client';
import './creg_monitor.css';
import { SEED_RESULT, mergeDedupe, mergeRango } from './data/seed.js';

const SYSTEM_PROMPT = `RESPONDE ÚNICAMENTE CON JSON PURO. Primer carácter: {. Último carácter: }. Cero texto antes o después.

ROL: Monitor regulatorio CREG Colombia. Solo español. Nunca inventes números de documentos.

ENTRADA: {"Tipos":[],"Rango":["YYYY-MM-DD","YYYY-MM-DD"],"Areas":[],"Relevancia_min":1}
Si inválido: {"error":"JSON inválido","campos_faltantes":[]}

BÚSQUEDA: Tiempo real en creg.gov.co → gestornormativo.creg.gov.co → minenergia.gov.co → diario-oficial.vlex.com.co. Omite no verificados, derogados o fuera de filtros. Si el JSON se aproxima al límite de tokens, cierra el array y el objeto correctamente antes de truncar.

SCHEMA: {"fecha_consulta":"YYYY-MM-DD","total_documentos":N,"fuentes_consultadas":["url"],"advertencia":"vacío o explicación si <6 docs","documentos":[{"numero_nombre":"str","fecha":"YYYY-MM-DD","tipo":"Resolución|Circular|Acuerdo","area":"str","relevancia":1,"confianza":"alta|media|baja","url_oficial":"https://","modifica_a":["str"],"descripcion":"str"}],"proyectos_en_consulta":[{"numero_nombre":"str","fecha":"YYYY-MM-DD","area":"str","url_oficial":"https://","descripcion":"str"}]}

REGLAS: total_documentos=len(documentos). confianza: alta=URL directa, media=referencia verificada, baja=fuente secundaria. Mínimo 6 documentos verificados.`

const TIPOS = ["Resolución", "Circular", "Acuerdo", "Concepto técnico"];
const TIPOS_LABEL = {
  "Resolución": "Resoluciones",
  "Circular": "Circulares",
  "Acuerdo": "Acuerdos",
  "Concepto técnico": "Conceptos técnicos",
};
const AREAS = [
  "Tarifas de energía","Gas natural","Energías renovables",
  "Mercado mayorista","Distribución eléctrica","GNL",
  "Subsidios","Redes inteligentes","Autogeneración","STN / Transporte"
];
const REL_LABEL = { 5: "Muy alta", 4: "Alta", 3: "Media", 2: "Baja", 1: "Mínima" };

const today = new Date().toISOString().split("T")[0];
const oneMonthAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().split("T")[0];

function CREGMonitor() {
  const [tipos, setTipos] = useState([...TIPOS]);
  const [areas, setAreas] = useState([...AREAS]);
  const rango = [oneMonthAgo, today];
  const [relevanciaMin, setRelevanciaMin] = useState(3);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(SEED_RESULT);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("documentos");
  const [sortField, setSortField] = useState("relevancia");
  const [sortDir, setSortDir] = useState("desc");
  const [filterArea, setFilterArea] = useState("Todas");
  const [filterTipo, setFilterTipo] = useState("Todos");
  const [mainTab, setMainTab] = useState("dashboard");
  const abortRef = useRef(null);

  const toggleTipo = (t) =>
    setTipos(p => p.includes(t) ? p.filter(x => x !== t) : [...p, t]);
  const toggleArea = (a) =>
    setAreas(p => p.includes(a) ? p.filter(x => x !== a) : [...p, a]);

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
      const raw = textBlock.text;
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No se encontró JSON en la respuesta");
      const parsed = JSON.parse(jsonMatch[0]);
      setResult(prev => {
        const documentos = mergeDedupe(parsed.documentos ?? [], prev?.documentos ?? []);
        const proyectos_en_consulta = mergeDedupe(parsed.proyectos_en_consulta ?? [], prev?.proyectos_en_consulta ?? []);
        const fuentes_consultadas = [...new Set([...(parsed.fuentes_consultadas ?? []), ...(prev?.fuentes_consultadas ?? [])])];
        const rango_de_fechas = mergeRango([prev, { rango_de_fechas: rango }]);
        return { ...parsed, documentos, proyectos_en_consulta, fuentes_consultadas, total_documentos: documentos.length, rango_de_fechas };
      });
      setActiveTab("documentos");
      setFilterArea("Todas");
      setFilterTipo("Todos");
    } catch (e) {
      if (e.name !== "AbortError") {
        setError("Error al procesar la respuesta: " + e.message);
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

  const SortIcon = ({ field }) => (
    <span className={`sort-icon${sortField === field ? ' active' : ''}`}>
      {sortField === field ? (sortDir === "asc" ? "↑" : "↓") : "⇅"}
    </span>
  );

  const th = (label, field, w) => (
    <th className="th-sort" style={{ width: w }} onClick={() => handleSort(field)}>
      {label} <SortIcon field={field} />
    </th>
  );

  const uniqueAreas = result?.documentos ? [...new Set(result.documentos.map(d => d.area))] : [];
  const uniqueTipos = result?.documentos ? [...new Set(result.documentos.map(d => d.tipo))] : [];

  const AREA_EMOJI = ["⚡","🔥","☀️","📈","🔌","💧","🧾","🧠","🔋","🏗️"];

  return (
    <div className="shell">

      {/* Header */}
      <div className="header">
        <div className="logo">⚡</div>
        <div className="header-text">
          <h1>Monitor CREG</h1>
          <p>Comisión de Regulación de Energía y Gas · Colombia</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        <button className={`tab${mainTab === 'dashboard' ? ' active' : ''}`} onClick={() => setMainTab('dashboard')}>
          Publicaciones recientes
        </button>
        <button className={`tab${mainTab === 'config' ? ' active' : ''}`} onClick={() => setMainTab('config')}>
          ⚙️ Configurar
        </button>
      </div>

      {/* ══ Dashboard panel ══ */}
      <div id="tab-dashboard" className={`section${mainTab === 'dashboard' ? ' active' : ''}`}>
        <div className="metrics">
          <div className="metric"><div className="val" id="m-resoluciones">0</div><div className="lbl">Resoluciones</div></div>
          <div className="metric"><div className="val" id="m-circulares">0</div><div className="lbl">Circulares</div></div>
          <div className="metric"><div className="val" id="m-acuerdos">0</div><div className="lbl">Acuerdos</div></div>
          <div className="metric"><div className="val" id="m-conceptos">0</div><div className="lbl">Conceptos técnicos</div></div>
        </div>
        <div className="row-apart">
          <button className={`btn btn-primary${loading ? ' loading' : ''}`} id="btn-scan"
            disabled={!tipos.length || !areas.length}
            onClick={loading ? handleStop : handleSearch}>
            {loading ? "⏹ Detener" : "⟳ Escanear ahora"}
          </button>
          {error && <div className="error-msg">{error}</div>}
        </div>

        {loading && (
          <div className="loading-state">
            <div className="loading-icon">⏳</div>
            Buscando en fuentes CREG en tiempo real...
          </div>
        )}
  
        {result && (
          <div>
            {/* Métricas */}
            <div className="result-metrics">
              {[
                ["Documentos", result.total_documentos ?? result.documentos?.length ?? 0],
                ["Proyectos", result.proyectos_en_consulta?.length ?? 0],
                ["Fuentes", result.fuentes_consultadas?.length ?? 0],
                ["Rango", result.rango_de_fechas ? result.rango_de_fechas.join(" / ") : "—"],
              ].map(([label, val]) => (
                <div key={label} className="result-metric">
                  <p className="lbl">{label}</p>
                  <p className="val">{val}</p>
                </div>
              ))}
            </div>
  
            {result.advertencia && <div className="warning-box">⚠ {result.advertencia}</div>}
  
            {/* Sub-tabs */}
            <div className="result-tabs">
              {[
                ["documentos", `Documentos (${result.documentos?.length ?? 0})`],
                ["proyectos", `Proyectos en consulta (${result.proyectos_en_consulta?.length ?? 0})`],
                ["fuentes", "Fuentes consultadas"],
              ].map(([key, label]) => (
                <button key={key} className={`result-tab${activeTab === key ? ' active' : ''}`}
                  onClick={() => setActiveTab(key)}>{label}</button>
              ))}
            </div>
  
            {activeTab === "documentos" && (
              <div>
                <div className="filters-row">
                  <select className="filter-select" value={filterArea} onChange={e => setFilterArea(e.target.value)}>
                    <option>Todas</option>
                    {uniqueAreas.map(a => <option key={a}>{a}</option>)}
                  </select>
                  <select className="filter-select" value={filterTipo} onChange={e => setFilterTipo(e.target.value)}>
                    <option>Todos</option>
                    {uniqueTipos.map(t => <option key={t}>{t}</option>)}
                  </select>
                  <span className="results-count">
                    {sortedDocs().length} resultado{sortedDocs().length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="table-wrap">
                  <table className="docs-table">
                    <thead>
                      <tr>
                        {th("Documento", "numero_nombre", "28%")}
                        {th("Fecha", "fecha", "9%")}
                        {th("Tipo", "tipo", "10%")}
                        {th("Área", "area", "14%")}
                        {th("Relev.", "relevancia", "7%")}
                        {th("Confianza", "confianza", "8%")}
                        <th className="th-plain" style={{ width: "24%" }}>Descripción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDocs().map((doc, i) => (
                        <tr key={i}>
                          <td className="td">
                            {doc.url_oficial && doc.url_oficial !== "https://" ? (
                              <a href={doc.url_oficial} className="doc-link">{doc.numero_nombre}</a>
                            ) : (
                              <span className="doc-title">{doc.numero_nombre}</span>
                            )}
                            {doc.modifica_a?.length > 0 && (
                              <div className="doc-modifica">Modifica: {doc.modifica_a.join(", ")}</div>
                            )}
                          </td>
                          <td className="td td-date">{doc.fecha}</td>
                          <td className="td"><span className="tipo-chip">{doc.tipo}</span></td>
                          <td className="td td-area">{doc.area}</td>
                          <td className="td">
                            <span className={`pill pill-rel-${doc.relevancia}`}>
                              {REL_LABEL[doc.relevancia] ?? doc.relevancia}
                            </span>
                          </td>
                          <td className="td">
                            <span className={`pill pill-conf-${doc.confianza?.split("=")[0] ?? 'baja'}`}>
                              {doc.confianza}
                            </span>
                          </td>
                          <td className="td td-desc">{doc.descripcion}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {sortedDocs().length === 0 && (
                    <p className="no-results">No hay documentos con los filtros actuales.</p>
                  )}
                </div>
              </div>
            )}
  
            {activeTab === "proyectos" && (
              <div>
                {result.proyectos_en_consulta?.length > 0 ? (
                  <table className="docs-table">
                    <thead>
                      <tr>
                        {[["Proyecto","34%"],["Fecha","11%"],["Área","17%"],["Descripción","38%"]].map(([h, w]) => (
                          <th key={h} className="th-plain" style={{ width: w }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.proyectos_en_consulta.map((p, i) => (
                        <tr key={i}>
                          <td className="td">
                            {p.url_oficial
                              ? <a href={p.url_oficial} className="doc-link">{p.numero_nombre}</a>
                              : <span className="doc-title">{p.numero_nombre}</span>}
                          </td>
                          <td className="td td-date">{p.fecha}</td>
                          <td className="td td-area">{p.area}</td>
                          <td className="td td-desc">{p.descripcion}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="no-results">No se encontraron proyectos en consulta para estos filtros.</p>
                )}
              </div>
            )}
  
            {activeTab === "fuentes" && (
              <div className="sources-list">
                {result.fuentes_consultadas?.map((url, i) => (
                  <a key={i} href={url} className="source-link">
                    <i className="ti ti-external-link" aria-hidden="true" />
                    {url}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══ Configurar panel ══ */}
      <div id="tab-config" className={`section${mainTab === 'config' ? ' active' : ''}`}>
        <div className="card card-mb">
          <h2 className="h2-sm">Temas de interés</h2>
          <p className="card-subtitle">El agente alertará sobre resoluciones relacionadas con estos temas</p>
          <div className="topic-grid">
            {AREAS.map((a, i) => (
              <div key={a} className={`topic-chip${areas.includes(a) ? ' on' : ''}`} onClick={() => toggleArea(a)}>
                {AREA_EMOJI[i]} {a}
              </div>
            ))}
          </div>
        </div>

        <div className="card card-mb">
          <h2 className="h2-md">Relevancia mínima para alertas</h2>
          <div className="rel-row">
            <input type="range" min={1} max={5} value={relevanciaMin}
              onChange={e => setRelevanciaMin(Number(e.target.value))} />
            <span className="rel-val">{relevanciaMin}/5</span>
          </div>
          <p className="card-hint">Solo recibirás alertas con puntuación igual o superior</p>
        </div>

        <div className="card card-mb">
          <h2 className="h2-sm">Tipo de documentos</h2>
          <div className="topic-grid">
            {TIPOS.map(t => (
              <div key={t} className={`topic-chip${tipos.includes(t) ? ' on' : ''}`} onClick={() => toggleTipo(t)}>
                {TIPOS_LABEL[t]}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<CREGMonitor />);
