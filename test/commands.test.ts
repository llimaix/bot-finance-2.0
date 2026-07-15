import { describe, expect, it } from 'vitest';
import { matchCommand, matchCorrection } from '../src/lib/commands';

describe('matchCommand', () => {
  it('reconoce los comandos base', () => {
    expect(matchCommand('/hoy')).toEqual({ kind: 'hoy' });
    expect(matchCommand('/semana')).toEqual({ kind: 'semana' });
    expect(matchCommand('/mes')).toEqual({ kind: 'mes' });
    expect(matchCommand('/reporte')).toEqual({ kind: 'reporte' });
  });

  it('tolera @NombreDelBot y mayúsculas', () => {
    expect(matchCommand('/hoy@FinanzasBot')).toEqual({ kind: 'hoy' });
    expect(matchCommand('/HOY')).toEqual({ kind: 'hoy' });
  });

  it('borrar con número, con # y sin argumento', () => {
    expect(matchCommand('/borrar 3')).toEqual({ kind: 'borrar', shortId: 3 });
    expect(matchCommand('/borrar #2')).toEqual({ kind: 'borrar', shortId: 2 });
    expect(matchCommand('/borrar')).toEqual({ kind: 'borrar', shortId: null });
    expect(matchCommand('/borrar abc')).toEqual({ kind: 'borrar', shortId: null });
  });

  it('atajo /nada', () => {
    expect(matchCommand('/nada')).toEqual({ kind: 'nada' });
    expect(matchCommand('/nada@MiPistoGTBot')).toEqual({ kind: 'nada' });
  });

  it('/categorias muestra la base de conocimientos', () => {
    expect(matchCommand('/categorias')).toEqual({ kind: 'categorias' });
  });

  it('/recurrentes lista los aprendidos', () => {
    expect(matchCommand('/recurrentes')).toEqual({ kind: 'recurrentes' });
  });

  it('/memoria lista los hechos aprendidos', () => {
    expect(matchCommand('/memoria')).toEqual({ kind: 'memoria' });
  });

  it('/proyeccion muestra el disponible a fin de mes', () => {
    expect(matchCommand('/proyeccion')).toEqual({ kind: 'proyeccion' });
  });

  it('/saldo: ver, ajustar y argumentos inválidos', () => {
    expect(matchCommand('/saldo')).toEqual({ kind: 'saldo', set: null, invalidArgs: false });
    expect(matchCommand('/saldo efectivo 350')).toEqual({
      kind: 'saldo',
      set: { account: 'efectivo', amount: 350 },
      invalidArgs: false,
    });
    expect(matchCommand('/saldo tarjeta -4,092.86')).toEqual({
      kind: 'saldo',
      set: { account: 'tarjeta', amount: -4092.86 },
      invalidArgs: false,
    });
    expect(matchCommand('/saldo bitcoin 100')).toEqual({ kind: 'saldo', set: null, invalidArgs: true });
    expect(matchCommand('/saldo efectivo abc')).toEqual({ kind: 'saldo', set: null, invalidArgs: true });
  });

  it('/metas: ver, sugerir, fijar, quitar e inválidos', () => {
    expect(matchCommand('/metas')).toEqual({ kind: 'metas', action: { op: 'ver' }, invalidArgs: false });
    expect(matchCommand('/metas sugerir')).toEqual({ kind: 'metas', action: { op: 'sugerir' }, invalidArgs: false });
    expect(matchCommand('/metas comida 1500')).toEqual({
      kind: 'metas',
      action: { op: 'fijar', category: 'comida', amount: 1500 },
      invalidArgs: false,
    });
    expect(matchCommand('/metas Comida 1,500.50')).toEqual({
      kind: 'metas',
      action: { op: 'fijar', category: 'comida', amount: 1500.5 },
      invalidArgs: false,
    });
    expect(matchCommand('/metas quitar comida')).toEqual({
      kind: 'metas',
      action: { op: 'quitar', category: 'comida' },
      invalidArgs: false,
    });
    expect(matchCommand('/metas comida')).toEqual({ kind: 'metas', action: { op: 'ver' }, invalidArgs: true });
    expect(matchCommand('/metas comida -50')).toEqual({ kind: 'metas', action: { op: 'ver' }, invalidArgs: true });
  });

  it('/costo consulta el consumo de IA', () => {
    expect(matchCommand('/costo')).toEqual({ kind: 'costo' });
  });

  it('start/help/ayuda → ayuda', () => {
    expect(matchCommand('/start')).toEqual({ kind: 'ayuda' });
    expect(matchCommand('/help')).toEqual({ kind: 'ayuda' });
    expect(matchCommand('/ayuda')).toEqual({ kind: 'ayuda' });
  });

  it('texto normal no es comando', () => {
    expect(matchCommand('gasté Q45 en almuerzo')).toBeNull();
    expect(matchCommand('hoy nada')).toBeNull();
  });
});

describe('matchCorrection', () => {
  it('forma canónica con #', () => {
    expect(matchCorrection('corrige #2 eran Q50')).toEqual({ shortId: 2, text: 'eran Q50' });
  });

  it('variantes: sin #, con dos puntos, mayúsculas, artículo', () => {
    expect(matchCorrection('Corrige 3: fue con débito')).toEqual({ shortId: 3, text: 'fue con débito' });
    expect(matchCorrection('corrige el #1, la categoría es transporte')).toEqual({
      shortId: 1,
      text: 'la categoría es transporte',
    });
  });

  it('no confunde texto normal', () => {
    expect(matchCorrection('gasté Q45 en almuerzo')).toBeNull();
    expect(matchCorrection('corrige')).toBeNull();
    expect(matchCorrection('corrige #2')).toBeNull();
  });
});
