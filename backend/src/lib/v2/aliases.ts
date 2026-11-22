/**
 * Normalización de alias (diseño, sección 3.2): minúsculas, sin tildes y con los
 * espacios colapsados. "Banco Industrial", "banco  industrial" y
 * "BANCO INDUSTRIAL" coinciden.
 */
export function normalizeAlias(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}
