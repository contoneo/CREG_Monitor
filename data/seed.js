import snap1 from './2026-05-01_14.json';
import snap2 from './2026-05-15_28.json';

// Normalize "Proyecto de Resolución CREG No. 701 122" == "Proyecto de Resolución CREG 701 122"
function normalizeKey(name) {
  return name.replace(/\bNo\.\s*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function mergeDedupe(arr1, arr2) {
  const seen = new Set();
  return [...arr1, ...arr2].filter(item => {
    const key = normalizeKey(item.numero_nombre);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const snaps = [snap1, snap2];

export function mergeRango(snapshots) {
  const starts = snapshots.map(s => s.rango_de_fechas[0]);
  const ends   = snapshots.map(s => s.rango_de_fechas[1]);
  return [starts.reduce((a, b) => a < b ? a : b), ends.reduce((a, b) => a > b ? a : b)];
}

// snap2 (May 15-28) listed first so its version wins on duplicates
const documentos = mergeDedupe(snap2.documentos, snap1.documentos);
const proyectos_en_consulta = mergeDedupe(snap2.proyectos_en_consulta, snap1.proyectos_en_consulta);
const fuentes_consultadas = [...new Set([...snap2.fuentes_consultadas, ...snap1.fuentes_consultadas])];

export const SEED_RESULT = {
  rango_de_fechas: mergeRango(snaps),
  total_documentos: documentos.length,
  fuentes_consultadas,
  documentos,
  proyectos_en_consulta,
};
