import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Path resolution and URL generation for static assets. */
export class FileManager {
  private readonly apiDomain: string;

  constructor(
    readonly staticPath: string,
    apiDomain: string,
  ) {
    this.apiDomain = apiDomain.replace(/\/+$/, '');
    mkdirSync(staticPath, { recursive: true });
  }

  /** Absolute path of a file in the static directory ("images/logo.png"). */
  getFullPath(fileName: string): string {
    return join(this.staticPath, fileName);
  }

  /** Public URL of a file in the static directory. */
  getFullUrl(fileName: string): string {
    return `${this.apiDomain}/static/${fileName}`;
  }

  /** Create a subdirectory of the static directory if needed and return its path. */
  ensureSubdirectory(subdirectory: string): string {
    const path = join(this.staticPath, subdirectory);
    mkdirSync(path, { recursive: true });
    return path;
  }
}
