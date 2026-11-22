/**
 * Diagnóstico del chat permitido SIN revelar su valor: longitud y si tiene
 * forma de chat ID de Telegram (entero; negativo en grupos). Sirve para ver en
 * el log "chat no permitido" si el secreto está mal cargado (otro número,
 * comillas, espacios) sin exponer el dato.
 */
export function chatIdDiagnostics(expected: string): { esperadoLongitud: number; esperadoNumerico: boolean } {
  return {
    esperadoLongitud: expected.length,
    esperadoNumerico: /^-?\d+$/.test(expected),
  };
}
