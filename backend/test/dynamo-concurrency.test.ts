import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '../src/lib/types';

// Cliente de DynamoDB falso: los comandos son los reales; solo `send` se sustituye.
const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>();
  return { ...actual, DynamoDBDocumentClient: { from: () => ({ send }) } };
});

const { appendConversation, pk, putFact } = await import('../src/lib/dynamo');

type Call = { name: string; input: Record<string, any> };
const calls = (): Call[] =>
  send.mock.calls.map(([cmd]) => ({ name: cmd.constructor.name as string, input: cmd.input }));
const conflict = () => new ConditionalCheckFailedException({ message: 'conflicto', $metadata: {} });
const msg = (text: string): ConversationMessage => ({ role: 'user', text, at: '2026-11-22T00:00:00.000Z' });

beforeEach(() => {
  send.mockReset();
  vi.stubEnv('TABLE_NAME', 'tabla-test');
  vi.stubEnv('ALLOWED_CHAT_ID', '987654');
});

describe('appendConversation (escrituras concurrentes)', () => {
  it('la primera vez escribe con versión 1 y la condición de "no existe"', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({});

    await appendConversation([msg('hola')]);

    const put = calls().find((c) => c.name === 'PutCommand')!;
    expect(put.input.Item.version).toBe(1);
    expect(put.input.ConditionExpression).toContain('attribute_not_exists');
  });

  it('si otro mensaje escribió entre la lectura y la escritura, relee y conserva los dos', async () => {
    send
      .mockResolvedValueOnce({ Item: { messages: [msg('a')], version: 2 } }) // lectura 1
      .mockRejectedValueOnce(conflict()) // escritura 1: otro mensaje ganó
      .mockResolvedValueOnce({ Item: { messages: [msg('a'), msg('concurrente')], version: 3 } }) // lectura 2
      .mockResolvedValueOnce({}); // escritura 2

    await appendConversation([msg('nuevo')]);

    const puts = calls().filter((c) => c.name === 'PutCommand');
    expect(puts).toHaveLength(2);
    const final = puts[1]!.input;
    expect(final.Item.messages.map((m: ConversationMessage) => m.text)).toEqual(['a', 'concurrente', 'nuevo']);
    expect(final.Item.version).toBe(4);
    expect(final.ConditionExpression).toBe('version = :v');
    expect(final.ExpressionAttributeValues).toEqual({ ':v': 3 });
  });

  it('lee de forma consistente', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await appendConversation([msg('x')]);
    expect(calls()[0]!.input.ConsistentRead).toBe(true);
  });

  it('recorta el historial a los últimos 12 mensajes', async () => {
    const previos = Array.from({ length: 12 }, (_, i) => msg(`m${i}`));
    send.mockResolvedValueOnce({ Item: { messages: previos, version: 1 } }).mockResolvedValueOnce({});

    await appendConversation([msg('nuevo')]);

    const put = calls().find((c) => c.name === 'PutCommand')!;
    expect(put.input.Item.messages).toHaveLength(12);
    expect(put.input.Item.messages.at(-1).text).toBe('nuevo');
  });

  it('tras 3 conflictos seguidos se rinde con el error', async () => {
    for (let i = 0; i < 3; i++) {
      send.mockResolvedValueOnce({ Item: { messages: [], version: i + 1 } }).mockRejectedValueOnce(conflict());
    }
    await expect(appendConversation([msg('x')])).rejects.toBeInstanceOf(ConditionalCheckFailedException);
    expect(calls().filter((c) => c.name === 'PutCommand')).toHaveLength(3);
  });

  it('otros errores no se reintentan', async () => {
    send.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('throttling'));
    await expect(appendConversation([msg('x')])).rejects.toThrow('throttling');
    expect(calls().filter((c) => c.name === 'PutCommand')).toHaveLength(1);
  });
});

describe('putFact (límite con escrituras concurrentes)', () => {
  const facts = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `f${i}`, text: 't', createdAt: `2026-11-22T00:00:${String(i).padStart(2, '0')}Z` }));
  const fact = { id: 'nuevo', text: 'mi salario cae el 15', createdAt: '2026-11-22T01:00:00Z' };

  it('si al volver a contar se superó el límite, deshace la propia escritura', async () => {
    send
      .mockResolvedValueOnce({ Items: facts(49) }) // antes: cabe
      .mockResolvedValueOnce({}) // put
      .mockResolvedValueOnce({ Items: facts(51) }) // después: otro entró a la vez
      .mockResolvedValueOnce({}); // delete propio

    await expect(putFact(fact)).rejects.toThrow('Límite de 50 hechos');

    const del = calls().find((c) => c.name === 'DeleteCommand')!;
    expect(del.input.Key.SK).toBe('FACT#nuevo');
  });

  it('sin concurrencia guarda el hecho y no borra nada', async () => {
    send.mockResolvedValueOnce({ Items: facts(3) }).mockResolvedValueOnce({}).mockResolvedValueOnce({ Items: facts(4) });

    await putFact(fact);

    expect(calls().some((c) => c.name === 'DeleteCommand')).toBe(false);
  });

  it('con el límite ya alcanzado no escribe', async () => {
    send.mockResolvedValueOnce({ Items: facts(50) });
    await expect(putFact(fact)).rejects.toThrow('Límite de 50 hechos');
    expect(calls().some((c) => c.name === 'PutCommand')).toBe(false);
  });

  it('cuenta con lectura consistente', async () => {
    send.mockResolvedValueOnce({ Items: facts(50) });
    await expect(putFact(fact)).rejects.toThrow();
    expect(calls()[0]!.input.ConsistentRead).toBe(true);
  });
});

describe('partición del usuario (PK)', () => {
  it('sale del chat permitido, no de un valor fijo en el código', () => {
    expect(pk()).toBe('USER#987654');
    vi.stubEnv('ALLOWED_CHAT_ID', '111');
    expect(pk()).toBe('USER#111');
  });

  it('las escrituras usan esa partición', async () => {
    send.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await appendConversation([msg('x')]);
    for (const c of calls()) {
      const key = c.input.Key ?? c.input.Item;
      expect(key.PK).toBe('USER#987654');
    }
  });
});
