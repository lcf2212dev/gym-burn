/**
 * Relógio do app. Existe para o compilador do React não tratar a leitura das
 * horas como uma chamada impura durante a renderização: as telas que precisam
 * de instantes (marcações, coleta, registros) pedem a hora por aqui, e não com
 * Date.now espalhado pelo componente.
 */
export function nowMs(): number {
  return Date.now();
}
