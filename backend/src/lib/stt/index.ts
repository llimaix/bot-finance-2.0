import { config } from '../config';
import { awsTranscribe } from './aws-transcribe';
import type { SttProvider } from './port';

export type { SttProvider } from './port';

/**
 * Factory del proveedor de speech-to-text, seleccionado por STT_PROVIDER.
 *
 * Para agregar otro proveedor (p.ej. Whisper de OpenAI vía el AI SDK):
 *   pnpm add @ai-sdk/openai
 *   // adapter con experimental_transcribe({ model: openai.transcription('whisper-1'), audio })
 *   case 'openai': return openaiWhisper;
 */
export function getSttProvider(): SttProvider {
  switch (config.sttProvider) {
    case 'aws':
      return awsTranscribe;
    default:
      throw new Error(
        `STT_PROVIDER no soportado: "${config.sttProvider}". Agrega su case en src/lib/stt/index.ts`,
      );
  }
}
