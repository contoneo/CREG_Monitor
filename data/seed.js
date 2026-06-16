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

export function mergeRango(snapshots) {
  const starts = snapshots.map(s => s.rango_de_fechas[0]);
  const ends   = snapshots.map(s => s.rango_de_fechas[1]);
  return [starts.reduce((a, b) => a < b ? a : b), ends.reduce((a, b) => a > b ? a : b)];
}
