import * as path from 'path';
import * as fs from 'fs/promises';
import { Request, Response, NextFunction } from 'express';
import StorageBase from 'ghost-storage-base';
import {
  BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

export interface AzureBlobStorageOptions {
  connectionString?: string;
  accountName?: string;
  accountKey?: string;
  container?: string;
  /** Custom domain base URL (accepts 'customDomain', 'cdnUrl', and 'cdn' config keys). Protocol is auto-prepended if missing. */
  customDomain?: string;
  cdnUrl?: string;
  cdn?: string;
  cacheControl?: string;
  pathPrefix?: string;
  /** Content path segment used in returned URLs: 'images' (default), 'media', or 'files'. */
  contentPath?: string;
  /** Injected BlobServiceClient for testing */
  blobServiceClient?: BlobServiceClient;
}

interface StorageFile {
  name: string;
  path: string;
  type?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

class AzureBlobStorageAdapter extends StorageBase {
  private containerName: string;
  private customDomain?: string;
  private cacheControl: string;
  private pathPrefix: string;
  private contentPath: string;
  private blobServiceClient: BlobServiceClient;
  private containerClient?: ContainerClient;
  private containerEnsured = false;

  constructor(config: AzureBlobStorageOptions = {}) {
    super();

    this.containerName = config.container || 'ghost-content';
    const cdnRaw = config.customDomain || config.cdnUrl || config.cdn;
    this.customDomain = cdnRaw ? this.normalizeCustomDomain(cdnRaw) : undefined;
    this.cacheControl = config.cacheControl || 'public, max-age=2592000';
    this.pathPrefix = config.pathPrefix ? config.pathPrefix.replace(/^\/+|\/+$/g, '') : '';
    this.contentPath = config.contentPath || 'images';

    if (config.blobServiceClient) {
      this.blobServiceClient = config.blobServiceClient;
    } else if (config.connectionString) {
      this.blobServiceClient = BlobServiceClient.fromConnectionString(config.connectionString);
    } else if (config.accountName && config.accountKey) {
      const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
      this.blobServiceClient = new BlobServiceClient(
        `https://${config.accountName}.blob.core.windows.net`,
        credential,
      );
    } else if (config.accountName) {
      // Lazy-load @azure/identity to avoid pulling in the heavy package unless needed
      const { DefaultAzureCredential } = require('@azure/identity');
      this.blobServiceClient = new BlobServiceClient(
        `https://${config.accountName}.blob.core.windows.net`,
        new DefaultAzureCredential(),
      );
    } else {
      throw new Error(
        'Azure Blob Storage adapter requires one of: connectionString, accountName+accountKey, or accountName (for managed identity)',
      );
    }
  }

  private async getContainerClient(): Promise<ContainerClient> {
    if (!this.containerClient) {
      this.containerClient = this.blobServiceClient.getContainerClient(this.containerName);
    }
    if (!this.containerEnsured) {
      await this.containerClient.createIfNotExists({ access: 'blob' });
      this.containerEnsured = true;
    }
    return this.containerClient;
  }

  private normalizeCustomDomain(url: string): string {
    url = url.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }
    return url;
  }

  private buildBlobPath(relativePath: string): string {
    // Normalize to forward slashes, strip leading slash
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (this.pathPrefix) {
      return `${this.pathPrefix}/${normalized}`;
    }
    return normalized;
  }

  private getBlobUrl(blobPath: string): string {
    if (this.customDomain) {
      return `${this.customDomain}/${this.containerName}/${blobPath}`;
    }
    const containerClient = this.blobServiceClient.getContainerClient(this.containerName);
    return `${containerClient.url}/${blobPath}`;
  }

  private getContentType(filePath: string, fileType?: string): string {
    if (fileType) {
      return fileType;
    }
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
  }

  async save(file: StorageFile, targetDir?: string): Promise<string> {
    const dir = targetDir || this.getTargetDir();
    const uniquePath: string = await this.getUniqueFileName(file, dir);

    const blobPath = this.buildBlobPath(uniquePath);
    const container = await this.getContainerClient();
    const blockBlobClient = container.getBlockBlobClient(blobPath);

    const fileData = await fs.readFile(file.path);
    const contentType = this.getContentType(file.name, file.type);

    await blockBlobClient.upload(fileData, fileData.length, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobCacheControl: this.cacheControl,
      },
    });

    // Return content-relative URL so Ghost can route requests through
    // the appropriate serve middleware for this content type.
    const normalizedPath = uniquePath.replace(/\\/g, '/').replace(/^\/+/, '');
    return `/content/${this.contentPath}/${normalizedPath}`;
  }

  async saveRaw(buffer: Buffer, targetPath: string): Promise<string> {
    const blobPath = this.buildBlobPath(targetPath);
    const container = await this.getContainerClient();
    const blockBlobClient = container.getBlockBlobClient(blobPath);

    const contentType = this.getContentType(targetPath);

    await blockBlobClient.upload(buffer, buffer.length, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobCacheControl: this.cacheControl,
      },
    });

    // Return content-relative URL so Ghost's middleware can locate the file.
    const normalizedTarget = targetPath.replace(/\\/g, '/').replace(/^\/+/, '');
    return `/content/${this.contentPath}/${normalizedTarget}`;
  }

  async exists(fileName: string, targetDir?: string): Promise<boolean> {
    const filePath = targetDir ? path.posix.join(targetDir, fileName) : fileName;
    const blobPath = this.buildBlobPath(filePath);
    const container = await this.getContainerClient();
    const blobClient = container.getBlobClient(blobPath);
    return blobClient.exists();
  }

  async delete(fileName: string, targetDir?: string): Promise<void> {
    const filePath = targetDir ? path.posix.join(targetDir, fileName) : fileName;
    const blobPath = this.buildBlobPath(filePath);
    const container = await this.getContainerClient();
    const blobClient = container.getBlobClient(blobPath);
    await blobClient.deleteIfExists();
  }

  async read(options: { path: string }): Promise<Buffer> {
    const blobPath = this.buildBlobPath(options.path);
    const container = await this.getContainerClient();
    const blobClient = container.getBlobClient(blobPath);
    return blobClient.downloadToBuffer();
  }

  serve(): (req: Request, res: Response, next: NextFunction) => void {
    return (req: Request, res: Response, next: NextFunction) => {
      const relativePath = req.path.replace(/^\/+/, '');
      if (!relativePath) {
        return next();
      }
      const blobPath = this.buildBlobPath(relativePath);
      const url = this.getBlobUrl(blobPath);
      res.redirect(301, url);
    };
  }

  urlToPath(url: string): string {
    let strippedPath: string;

    // Handle relative content URLs (from new saves)
    const contentPrefix = `/content/${this.contentPath}/`;
    if (url.startsWith(contentPrefix)) {
      strippedPath = url.slice(contentPrefix.length);
    } else if (this.customDomain && url.startsWith(this.customDomain)) {
      strippedPath = url.slice(this.customDomain.length);
    } else {
      // Strip the blob storage URL prefix
      const containerUrl = this.blobServiceClient
        .getContainerClient(this.containerName).url;
      if (url.startsWith(containerUrl)) {
        strippedPath = url.slice(containerUrl.length);
      } else {
        // Return as-is if URL doesn't match known prefixes
        strippedPath = url;
      }
    }

    // Remove leading slash
    strippedPath = strippedPath.replace(/^\/+/, '');

    // Strip pathPrefix if present
    if (this.pathPrefix && strippedPath.startsWith(this.pathPrefix + '/')) {
      strippedPath = strippedPath.slice(this.pathPrefix.length + 1);
    }

    // Strip container name if present (CDN URLs include the container in the path)
    if (strippedPath.startsWith(this.containerName + '/')) {
      strippedPath = strippedPath.slice(this.containerName.length + 1);
    }

    // Strip content/{contentPath}/ prefix (from old data or relative content URLs)
    strippedPath = strippedPath.replace(new RegExp(`^content/${this.contentPath}/`), '');
    // Also strip content/images/ for backward compatibility with older data
    if (this.contentPath !== 'images') {
      strippedPath = strippedPath.replace(/^content\/images\//, '');
    }

    return strippedPath;
  }
}

module.exports = AzureBlobStorageAdapter;
export default AzureBlobStorageAdapter;
export { AzureBlobStorageAdapter };
