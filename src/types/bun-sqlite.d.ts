declare module "bun:sqlite" {
  export interface DatabaseOptions {
    create?: boolean
    readwrite?: boolean
    strict?: boolean
  }

  export class Database {
    constructor(filename?: string, options?: DatabaseOptions)
    exec(sql: string): void
    close(): void
    loadExtension(path: string, entryPoint?: string): void
  }
}
