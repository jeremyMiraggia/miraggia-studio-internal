// Stub minimal pour typecheck local — Vercel installe le vrai package + types.
declare module '@huggingface/transformers' {
  const x: any
  export default x
  export const pipeline: any
  export const RawImage: any
  export const env: any
}
