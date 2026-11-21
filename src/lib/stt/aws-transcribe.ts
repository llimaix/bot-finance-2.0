import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
} from '@aws-sdk/client-transcribe-streaming';
import { logger } from '../logger';
import type { SttProvider } from './port';

const client = new TranscribeStreamingClient({});

const CHUNK_SIZE = 4 * 1024;

// Con la arquitectura asíncrona (processor 120s) hay espacio para notas de voz
// largas; el tope solo evita colgarse si Transcribe se atasca.
const TIMEOUT_MS = 25_000;

/**
 * Amazon Transcribe en modo STREAMING: acepta ogg-opus (el formato exacto de
 * las notas de voz de Telegram, 48kHz) directamente — sin bucket S3 ni polling.
 * es-US es la variante entrenada con español latinoamericano.
 */
export const awsTranscribe: SttProvider = {
  async transcribe(audio: Buffer): Promise<string> {
    async function* audioStream() {
      for (let i = 0; i < audio.length; i += CHUNK_SIZE) {
        yield { AudioEvent: { AudioChunk: audio.subarray(i, i + CHUNK_SIZE) } };
      }
    }

    const res = await client.send(
      new StartStreamTranscriptionCommand({
        LanguageCode: 'es-US',
        MediaEncoding: 'ogg-opus',
        MediaSampleRateHertz: 48_000,
        AudioStream: audioStream(),
      }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
    );

    const parts: string[] = [];
    for await (const event of res.TranscriptResultStream ?? []) {
      for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
        const alt = result.Alternatives?.[0]?.Transcript;
        if (!result.IsPartial && alt) parts.push(alt);
      }
    }

    const text = parts.join(' ').trim();
    logger.info('transcripción completada', { bytes: audio.length, text });
    if (!text) throw new Error('La transcripción quedó vacía');
    return text;
  },
};
