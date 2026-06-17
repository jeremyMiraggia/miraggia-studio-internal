// Stub minimal pour typecheck local — Vercel installe le vrai package + types.
declare module 'xlsx-js-style' {
  const x: any
  export default x
  export const utils: any
  export const read: any
  export const readFile: any
  export const write: any
  export const writeFile: any
}
