// The part of Vite's import.meta.glob that the fixture loader uses. Declared
// here so core's tests don't need vite/client types.
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options: { eager: true; query?: string; import?: string },
  ): Record<string, T>;
}
