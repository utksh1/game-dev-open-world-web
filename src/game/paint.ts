/**
 * Round 9: the respray palette shared by the GarageSystem (engine side)
 * and the GaragePanel (UI side). Lives in its own three.js-free module
 * so UI imports never drag the renderer into the landing bundle.
 */
export interface ResprayColor {
  hex: number
  name: string
}

export const RESPRAY_COLORS: ResprayColor[] = [
  { hex: 0xe7e5e4, name: 'Pearl White' },
  { hex: 0x18181b, name: 'Midnight Black' },
  { hex: 0xd4d4d8, name: 'Sterling Silver' },
  { hex: 0xdc2626, name: 'Scarlet' },
  { hex: 0xf59e0b, name: 'Sunset Orange' },
  { hex: 0xfacc15, name: 'Cab Yellow' },
  { hex: 0x16a34a, name: 'Racing Green' },
  { hex: 0x0d9488, name: 'Teal Steel' },
  { hex: 0x9f1239, name: 'Burgundy' },
  { hex: 0x65a30d, name: 'Acid Lime' },
]

/** hex number → '#rrggbb' for CSS. */
export function hexToCss(hex: number | null | undefined): string {
  if (hex == null) return '#71717a'
  return `#${hex.toString(16).padStart(6, '0')}`
}
