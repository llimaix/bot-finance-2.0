import { describe, expect, it } from 'vitest';
import {
  findCuenta,
  planCrearCuenta,
  planEditarCuenta,
  planEntidad,
  resumenCuenta,
  slugify,
} from '../src/lib/v2/config';
import type { ConfigSnapshot, CrearCuentaInput, EditarCuentaInput } from '../src/lib/v2/config';

const TODAY = '2026-11-22';

const sinCredito = { diaCorte: null, diaPago: null, limite: null, tasaInteres: null, periodoTasa: null } as const;
const sinPrestamo = { cuotaMensual: null, plazoCuotas: null, vence: null } as const;

const crear = (over: Partial<CrearCuentaInput>): CrearCuentaInput => ({
  nombre: 'Visa BAC',
  tipo: 'credito',
  entidad: 'BAC',
  alias: ['la visa'],
  terminaciones: ['1111'],
  saldoActual: 1500,
  diaCorte: 15,
  diaPago: 5,
  limite: 10000,
  tasaInteres: 3.5,
  periodoTasa: 'mensual',
  ...sinPrestamo,
  ...over,
});

const editar = (over: Partial<EditarCuentaInput>): EditarCuentaInput => ({
  cuenta: 'visa-bac',
  nuevoNombre: null,
  agregarAlias: [],
  quitarAlias: [],
  agregarTerminaciones: [],
  quitarTerminaciones: [],
  saldoActual: null,
  activa: null,
  nuevoTipo: null,
  ...sinCredito,
  ...sinPrestamo,
  ...over,
});

const vacio: ConfigSnapshot = { cuentas: [], entidades: [] };

/** Configuración con la Visa BAC ya creada. */
function conVisa(): ConfigSnapshot {
  const plan = planCrearCuenta(crear({}), vacio, TODAY);
  if (!plan.ok) throw new Error(plan.errors.join());
  return { cuentas: [plan.value.cuenta], entidades: [plan.value.entidadNueva!] };
}

describe('crear cuenta', () => {
  it('tarjeta completa: id, entidad nueva, deuda en negativo y tasa en puntos básicos', () => {
    const plan = planCrearCuenta(crear({}), vacio, TODAY);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const { cuenta, entidadNueva } = plan.value;
    expect(cuenta).toMatchObject({
      id: 'visa-bac',
      tipo: 'credito',
      entidadId: 'bac',
      terminaciones: ['1111'],
      semillaCentavos: -150_000,
      asOf: TODAY,
      estimada: false,
      credito: { limiteCentavos: 1_000_000, diaCorte: 15, diaPago: 5, interes: { tasaBps: 350, periodo: 'mensual' } },
    });
    expect(entidadNueva).toEqual({ id: 'bac', nombre: 'BAC', alias: ['BAC'] });
  });

  it('una tarjeta de crédito sin corte, pago o límite no se guarda', () => {
    const plan = planCrearCuenta(crear({ diaCorte: null, limite: null }), vacio, TODAY);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors).toEqual(['Falta el día de corte de la tarjeta.', 'Falta el límite de la tarjeta.']);
  });

  it('la tasa es opcional', () => {
    const plan = planCrearCuenta(crear({ tasaInteres: null }), vacio, TODAY);
    expect(plan.ok && plan.value.cuenta.credito?.interes).toBeUndefined();
  });

  it('reutiliza la entidad existente aunque se escriba distinto ("banco industrial" = "Banco Industrial")', () => {
    const snap: ConfigSnapshot = { cuentas: [], entidades: [{ id: 'bi', nombre: 'Banco Industrial', alias: ['bi'] }] };
    const plan = planCrearCuenta(
      crear({ nombre: 'BI Débito', tipo: 'banco', entidad: 'banco  industrial', terminaciones: ['2222'], alias: [], ...sinCredito }),
      snap,
      TODAY,
    );
    expect(plan.ok && plan.value).toMatchObject({ cuenta: { entidadId: 'bi' }, entidadNueva: null });
  });

  it('no permite una terminación que ya tiene otra cuenta', () => {
    const plan = planCrearCuenta(crear({ nombre: 'Otra', entidad: 'BAC', alias: [] }), conVisa(), TODAY);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors.join()).toContain('1111');
  });

  it('nombre repetido → id único', () => {
    const plan = planCrearCuenta(crear({ terminaciones: ['9999'], alias: [] }), conVisa(), TODAY);
    expect(plan.ok && plan.value.cuenta.id).toBe('visa-bac-2');
  });

  it('efectivo no lleva banco aunque el modelo lo mande', () => {
    const plan = planCrearCuenta(
      crear({ nombre: 'Efectivo', tipo: 'efectivo', entidad: 'BAC', terminaciones: [], alias: [], saldoActual: 350, ...sinCredito }),
      vacio,
      TODAY,
    );
    expect(plan.ok && plan.value).toMatchObject({ cuenta: { entidadId: null, semillaCentavos: 35_000 }, entidadNueva: null });
  });

  it('sin saldo, queda en 0 marcado como estimado', () => {
    const plan = planCrearCuenta(crear({ saldoActual: null }), vacio, TODAY);
    expect(plan.ok && plan.value.cuenta).toMatchObject({ semillaCentavos: 0, estimada: true });
  });
});

describe('editar cuenta', () => {
  it('agrega una terminación y busca la cuenta por cualquiera de sus terminaciones', () => {
    const plan = planEditarCuenta(editar({ cuenta: '••1111', agregarTerminaciones: ['2222'] }), conVisa(), TODAY);
    expect(plan.ok && plan.value.despues.terminaciones).toEqual(['1111', '2222']);
  });

  it('quita alias sin importar mayúsculas ni tildes', () => {
    const plan = planEditarCuenta(editar({ quitarAlias: ['LA VISA'] }), conVisa(), TODAY);
    expect(plan.ok && plan.value.despues.alias).toEqual([]);
  });

  it('cambiar el saldo actualiza la fecha de corte de la semilla', () => {
    const plan = planEditarCuenta(editar({ saldoActual: 2000 }), conVisa(), '2026-12-01');
    expect(plan.ok && plan.value.despues).toMatchObject({ semillaCentavos: -200_000, asOf: '2026-12-01', estimada: false });
  });

  it('cambia el corte y conserva el resto de los datos de crédito', () => {
    const plan = planEditarCuenta(editar({ diaCorte: 20 }), conVisa(), TODAY);
    expect(plan.ok && plan.value.despues.credito).toMatchObject({ diaCorte: 20, diaPago: 5, limiteCentavos: 1_000_000 });
  });

  it('una cuenta que no es de crédito no acepta corte, pago ni límite', () => {
    const snap = conVisa();
    const debito = planCrearCuenta(
      crear({ nombre: 'BI', tipo: 'banco', entidad: 'BI', terminaciones: [], alias: [], ...sinCredito }),
      snap,
      TODAY,
    );
    if (!debito.ok) throw new Error(debito.errors.join());
    const plan = planEditarCuenta(
      editar({ cuenta: 'BI', diaCorte: 15 }),
      { cuentas: [...snap.cuentas, debito.value.cuenta], entidades: [...snap.entidades, debito.value.entidadNueva!] },
      TODAY,
    );
    expect(plan.ok).toBe(false);
  });

  it('una cuenta inexistente devuelve las disponibles', () => {
    const plan = planEditarCuenta(editar({ cuenta: 'mastercard' }), conVisa(), TODAY);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors[0]).toContain('Visa BAC');
  });

  it('cerrar la cuenta la marca inactiva sin borrarla', () => {
    const plan = planEditarCuenta(editar({ activa: false }), conVisa(), TODAY);
    expect(plan.ok && plan.value.despues.activa).toBe(false);
  });
});

describe('entidades', () => {
  it('agrega alias a una entidad existente sin duplicar', () => {
    const plan = planEntidad({ nombre: 'bac', agregarAlias: ['BAC Credomatic', 'BAC'] }, conVisa());
    expect(plan.ok && plan.value).toMatchObject({ antes: { id: 'bac' }, despues: { alias: ['BAC', 'BAC Credomatic'] } });
  });

  it('crea una entidad nueva con su nombre como primer alias', () => {
    const plan = planEntidad({ nombre: 'Banco Industrial', agregarAlias: ['BI', 'el Industrial'] }, vacio);
    expect(plan.ok && plan.value).toMatchObject({
      antes: null,
      despues: { id: 'banco-industrial', alias: ['Banco Industrial', 'BI', 'el Industrial'] },
    });
  });

  it('no permite un alias que ya es de una cuenta', () => {
    const plan = planEntidad({ nombre: 'Otro banco', agregarAlias: ['la visa'] }, conVisa());
    expect(plan.ok).toBe(false);
  });
});

describe('búsqueda y resumen', () => {
  it('findCuenta por id, nombre, alias y terminación', () => {
    const { cuentas } = conVisa();
    for (const ref of ['visa-bac', 'Visa BAC', 'LA VISA', '1111', '••1111']) expect(findCuenta(ref, cuentas)?.id, ref).toBe('visa-bac');
    expect(findCuenta('2222', cuentas)).toBeUndefined();
  });

  it('el resumen refleja exactamente lo guardado', () => {
    const snap = conVisa();
    const html = resumenCuenta(snap.cuentas[0]!, snap.entidades);
    for (const parte of ['Visa BAC', 'crédito', 'BAC', '••1111', 'Corte 15', 'pago 5', 'límite Q10,000.00', 'interés 3.5% mensual', 'Deuda: Q1,500.00', 'Alias: la visa']) {
      expect(html, parte).toContain(parte);
    }
  });

  it('escapa el HTML de nombres y alias', () => {
    const plan = planCrearCuenta(crear({ nombre: 'Visa <b>', alias: ['a&b'] }), vacio, TODAY);
    if (!plan.ok) throw new Error(plan.errors.join());
    const html = resumenCuenta(plan.value.cuenta, [plan.value.entidadNueva!]);
    expect(html).toContain('Visa &lt;b&gt;');
    expect(html).toContain('a&amp;b');
  });

  it('slugify produce ids legibles', () => {
    expect(slugify('Visa BAC Platino!')).toBe('visa-bac-platino');
    expect(slugify('Débito Banrural')).toBe('debito-banrural');
    expect(slugify('***')).toBe('cuenta');
  });
});
