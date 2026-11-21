/**
 * Puerto de speech-to-text: la lógica de negocio solo conoce esta interfaz.
 * Cambiar de proveedor = escribir/activar otro adapter (ver index.ts).
 */
export interface SttProvider {
  /** Transcribe una nota de voz. Lanza si la transcripción falla o queda vacía. */
  transcribe(audio: Buffer, mimeType?: string): Promise<string>;
}
