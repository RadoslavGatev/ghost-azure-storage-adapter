import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock types matching Azure SDK interfaces ---

function createMockBlockBlobClient() {
  return {
    upload: vi.fn().mockResolvedValue({}),
  };
}

function createMockBlobClient(existsResult = false) {
  return {
    exists: vi.fn().mockResolvedValue(existsResult),
    deleteIfExists: vi.fn().mockResolvedValue({ succeeded: true }),
    downloadToBuffer: vi.fn().mockResolvedValue(Buffer.from('file-content')),
  };
}

function createMockContainerClient(containerName: string, accountUrl: string) {
  const blockBlobClients: Record<string, ReturnType<typeof createMockBlockBlobClient>> = {};
  const blobClients: Record<string, ReturnType<typeof createMockBlobClient>> = {};

  return {
    url: `${accountUrl}/${containerName}`,
    createIfNotExists: vi.fn().mockResolvedValue({}),
    getBlockBlobClient: vi.fn((name: string) => {
      if (!blockBlobClients[name]) {
        blockBlobClients[name] = createMockBlockBlobClient();
      }
      return blockBlobClients[name];
    }),
    getBlobClient: vi.fn((name: string) => {
      if (!blobClients[name]) {
        blobClients[name] = createMockBlobClient();
      }
      return blobClients[name];
    }),
    _blockBlobClients: blockBlobClients,
    _blobClients: blobClients,
    _setBlobExists(name: string, exists: boolean) {
      blobClients[name] = createMockBlobClient(exists);
    },
  };
}

function createMockBlobServiceClient(accountUrl = 'https://testaccount.blob.core.windows.net') {
  const containers: Record<string, ReturnType<typeof createMockContainerClient>> = {};

  return {
    url: accountUrl,
    getContainerClient: vi.fn((name: string) => {
      if (!containers[name]) {
        containers[name] = createMockContainerClient(name, accountUrl);
      }
      return containers[name];
    }),
    _containers: containers,
  } as any;
}

// We need to mock fs/promises for save()
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('image-data')),
}));

// Mock @azure/storage-blob to avoid loading the heavy SDK in tests
vi.mock('@azure/storage-blob', () => ({
  BlobServiceClient: class {
    static fromConnectionString() { return {}; }
  },
  StorageSharedKeyCredential: class {},
}));

// Import after mocks
import AzureBlobStorageAdapter from '../src/AzureBlobStorageAdapter';
import AzureImagesStorage from '../src/AzureImagesStorage';
import AzureMediaStorage from '../src/AzureMediaStorage';
import AzureFilesStorage from '../src/AzureFilesStorage';

describe('AzureBlobStorageAdapter', () => {
  describe('constructor', () => {
    it('should throw when no auth config is provided', () => {
      expect(() => new AzureBlobStorageAdapter({})).toThrow(
        'Azure Blob Storage adapter requires one of',
      );
    });

    it('should accept an injected blobServiceClient', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
      });
      expect(adapter).toBeDefined();
    });

    it('should use default container name when not specified', async () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: undefined,
      });
      // Trigger container client creation
      await adapter.exists('test.jpg');
      expect(mockClient.getContainerClient).toHaveBeenCalledWith('ghost-content');
    });

    it('should use custom container name', async () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'my-images',
      });
      await adapter.exists('test.jpg');
      expect(mockClient.getContainerClient).toHaveBeenCalledWith('my-images');
    });
  });

  describe('save()', () => {
    let adapter: InstanceType<typeof AzureBlobStorageAdapter>;
    let mockClient: ReturnType<typeof createMockBlobServiceClient>;

    beforeEach(() => {
      mockClient = createMockBlobServiceClient();
      adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });
    });

    it('should upload a file and return its content-relative URL', async () => {
      const file = { name: 'photo.jpg', path: '/tmp/photo.jpg', type: 'image/jpeg' };
      const url = await adapter.save(file);

      // Should return content-relative URL (not absolute Azure URL)
      expect(url).toMatch(/^\/content\/images\//);
      expect(url).toContain('photo');

      // Verify upload was called on a blob path WITHOUT content/images/ prefix
      const container = mockClient._containers['ghost-content'];
      const uploadedKey = Object.keys(container._blockBlobClients)[0];
      expect(uploadedKey).not.toContain('content/images/');
      const blockBlob = container._blockBlobClients[uploadedKey];
      expect(blockBlob.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        expect.objectContaining({
          blobHTTPHeaders: expect.objectContaining({
            blobContentType: 'image/jpeg',
            blobCacheControl: 'public, max-age=2592000',
          }),
        }),
      );
    });

    it('should upload to the correct path with pathPrefix', async () => {
      const prefixedAdapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        pathPrefix: 'images',
      });
      const file = { name: 'photo.jpg', path: '/tmp/photo.jpg', type: 'image/jpeg' };
      const url = await prefixedAdapter.save(file);

      // URL is still content-relative
      expect(url).toMatch(/^\/content\/images\//);
      // Blob path should include the prefix
      const container = mockClient._containers['ghost-content'];
      const uploadedKey = Object.keys(container._blockBlobClients)[0];
      expect(uploadedKey).toMatch(/^images\//);
    });

    it('should use custom cacheControl', async () => {
      const customAdapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        cacheControl: 'no-cache',
      });
      const file = { name: 'photo.jpg', path: '/tmp/photo.jpg', type: 'image/jpeg' };
      await customAdapter.save(file);

      const container = mockClient._containers['ghost-content'];
      const uploadedKey = Object.keys(container._blockBlobClients)[0];
      const blockBlob = container._blockBlobClients[uploadedKey];
      expect(blockBlob.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        expect.objectContaining({
          blobHTTPHeaders: expect.objectContaining({
            blobCacheControl: 'no-cache',
          }),
        }),
      );
    });

    it('should infer content type from extension when file.type is not provided', async () => {
      const file = { name: 'photo.png', path: '/tmp/photo.png' };
      await adapter.save(file);

      const container = mockClient._containers['ghost-content'];
      const uploadedKey = Object.keys(container._blockBlobClients)[0];
      const blockBlob = container._blockBlobClients[uploadedKey];
      expect(blockBlob.upload).toHaveBeenCalledWith(
        expect.any(Buffer),
        expect.any(Number),
        expect.objectContaining({
          blobHTTPHeaders: expect.objectContaining({
            blobContentType: 'image/png',
          }),
        }),
      );
    });

    it('should return content-relative URL even when customDomain is configured', async () => {
      const cdnAdapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        customDomain: 'https://cdn.example.com',
      });
      const file = { name: 'photo.jpg', path: '/tmp/photo.jpg', type: 'image/jpeg' };
      const url = await cdnAdapter.save(file);

      // Even with customDomain configured, save() returns content-relative URL
      expect(url).toMatch(/^\/content\/images\//);
    });

    it('should return content/media/ URL when contentPath is media', async () => {
      const mediaAdapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        contentPath: 'media',
      });
      const file = { name: 'episode.mp3', path: '/tmp/episode.mp3', type: 'audio/mpeg' };
      const url = await mediaAdapter.save(file);

      expect(url).toMatch(/^\/content\/media\//);
      expect(url).toContain('episode');
    });

    it('should return content/files/ URL when contentPath is files', async () => {
      const filesAdapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        contentPath: 'files',
      });
      const file = { name: 'doc.pdf', path: '/tmp/doc.pdf', type: 'application/pdf' };
      const url = await filesAdapter.save(file);

      expect(url).toMatch(/^\/content\/files\//);
      expect(url).toContain('doc');
    });
  });

  describe('saveRaw()', () => {
    let adapter: InstanceType<typeof AzureBlobStorageAdapter>;
    let mockClient: ReturnType<typeof createMockBlobServiceClient>;

    beforeEach(() => {
      mockClient = createMockBlobServiceClient();
      adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });
    });

    it('should upload a buffer and return content-relative URL', async () => {
      const buffer = Buffer.from('raw-content');
      const url = await adapter.saveRaw(buffer, '2024/01/data.json');

      expect(url).toBe('/content/images/2024/01/data.json');

      const container = mockClient._containers['ghost-content'];
      const blockBlob = container._blockBlobClients['2024/01/data.json'];
      expect(blockBlob.upload).toHaveBeenCalledWith(
        buffer,
        buffer.length,
        expect.objectContaining({
          blobHTTPHeaders: expect.objectContaining({
            blobContentType: 'application/json',
          }),
        }),
      );
    });

    it('should apply pathPrefix to raw uploads', async () => {
      const prefixedAdapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        pathPrefix: 'data',
      });
      const buffer = Buffer.from('raw');
      const url = await prefixedAdapter.saveRaw(buffer, 'file.txt');

      expect(url).toBe('/content/images/file.txt');
      // Blob should be stored with the prefix
      const container = mockClient._containers['ghost-content'];
      expect(container.getBlockBlobClient).toHaveBeenCalledWith('data/file.txt');
    });

    it('should save responsive image sizes', async () => {
      const buffer = Buffer.from('resized-image');
      const url = await adapter.saveRaw(buffer, '/size/w600/2024/01/photo.jpg');

      expect(url).toBe('/content/images/size/w600/2024/01/photo.jpg');
      const container = mockClient._containers['ghost-content'];
      expect(container.getBlockBlobClient).toHaveBeenCalledWith('size/w600/2024/01/photo.jpg');
    });
  });

  describe('exists()', () => {
    let adapter: InstanceType<typeof AzureBlobStorageAdapter>;
    let mockClient: ReturnType<typeof createMockBlobServiceClient>;

    beforeEach(() => {
      mockClient = createMockBlobServiceClient();
      adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });
    });

    it('should return true when blob exists', async () => {
      // Pre-configure the mock to return true
      const container = createMockContainerClient(
        'ghost-content',
        'https://testaccount.blob.core.windows.net',
      );
      container._setBlobExists('2024/01/photo.jpg', true);
      mockClient._containers['ghost-content'] = container;

      const result = await adapter.exists('photo.jpg', '2024/01');
      expect(result).toBe(true);
    });

    it('should return false when blob does not exist', async () => {
      const result = await adapter.exists('missing.jpg', '2024/01');
      expect(result).toBe(false);
    });

    it('should work without targetDir', async () => {
      const container = createMockContainerClient(
        'ghost-content',
        'https://testaccount.blob.core.windows.net',
      );
      container._setBlobExists('photo.jpg', true);
      mockClient._containers['ghost-content'] = container;

      const result = await adapter.exists('photo.jpg');
      expect(result).toBe(true);
    });
  });

  describe('delete()', () => {
    let adapter: InstanceType<typeof AzureBlobStorageAdapter>;
    let mockClient: ReturnType<typeof createMockBlobServiceClient>;

    beforeEach(() => {
      mockClient = createMockBlobServiceClient();
      adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });
    });

    it('should delete a blob', async () => {
      await adapter.delete('photo.jpg', '2024/01');

      const container = mockClient._containers['ghost-content'];
      const blobClient = container._blobClients['2024/01/photo.jpg'];
      expect(blobClient.deleteIfExists).toHaveBeenCalled();
    });

    it('should handle missing blobs gracefully', async () => {
      const container = createMockContainerClient(
        'ghost-content',
        'https://testaccount.blob.core.windows.net',
      );
      mockClient._containers['ghost-content'] = container;

      // deleteIfExists returns succeeded: false for missing blobs
      const mockBlobClient = createMockBlobClient();
      mockBlobClient.deleteIfExists.mockResolvedValue({ succeeded: false });
      container._blobClients['2024/01/missing.jpg'] = mockBlobClient as any;

      await adapter.delete('missing.jpg', '2024/01');
    });
  });

  describe('read()', () => {
    let adapter: InstanceType<typeof AzureBlobStorageAdapter>;
    let mockClient: ReturnType<typeof createMockBlobServiceClient>;

    beforeEach(() => {
      mockClient = createMockBlobServiceClient();
      adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });
    });

    it('should download blob to buffer', async () => {
      const buffer = await adapter.read({ path: '2024/01/photo.jpg' });
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.toString()).toBe('file-content');
    });

    it('should apply pathPrefix when reading', async () => {
      const prefixedAdapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        pathPrefix: 'images',
      });
      await prefixedAdapter.read({ path: '2024/01/photo.jpg' });

      const container = mockClient._containers['ghost-content'];
      expect(container.getBlobClient).toHaveBeenCalledWith('images/2024/01/photo.jpg');
    });
  });

  describe('serve()', () => {
    it('should redirect to Azure Blob URL', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
      });

      const middleware = adapter.serve();
      const req = { path: '/2024/01/photo.jpg' } as any;
      const res = { redirect: vi.fn() } as any;
      const next = vi.fn();
      middleware(req, res, next);

      expect(res.redirect).toHaveBeenCalledWith(
        301,
        'https://testaccount.blob.core.windows.net/ghost-content/2024/01/photo.jpg',
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('should redirect responsive image size requests to Azure', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
      });

      const middleware = adapter.serve();
      const req = { path: '/size/w600/2024/01/photo.jpg' } as any;
      const res = { redirect: vi.fn() } as any;
      const next = vi.fn();
      middleware(req, res, next);

      expect(res.redirect).toHaveBeenCalledWith(
        301,
        'https://testaccount.blob.core.windows.net/ghost-content/size/w600/2024/01/photo.jpg',
      );
    });

    it('should use custom domain URL when configured', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        customDomain: 'https://cdn.example.com',
      });

      const middleware = adapter.serve();
      const req = { path: '/2024/01/photo.jpg' } as any;
      const res = { redirect: vi.fn() } as any;
      const next = vi.fn();
      middleware(req, res, next);

      expect(res.redirect).toHaveBeenCalledWith(
        301,
        'https://cdn.example.com/ghost-content/2024/01/photo.jpg',
      );
    });

    it('should accept cdn as alias for customDomain', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        cdn: 'https://cdn.example.com',
      });

      const middleware = adapter.serve();
      const req = { path: '/2024/01/photo.jpg' } as any;
      const res = { redirect: vi.fn() } as any;
      const next = vi.fn();
      middleware(req, res, next);

      expect(res.redirect).toHaveBeenCalledWith(
        301,
        'https://cdn.example.com/ghost-content/2024/01/photo.jpg',
      );
    });

    it('should auto-prepend https:// when protocol is missing from cdn', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        cdn: 'cdn.example.com',
      });

      const middleware = adapter.serve();
      const req = { path: '/2024/01/photo.jpg' } as any;
      const res = { redirect: vi.fn() } as any;
      const next = vi.fn();
      middleware(req, res, next);

      expect(res.redirect).toHaveBeenCalledWith(
        301,
        'https://cdn.example.com/ghost-content/2024/01/photo.jpg',
      );
    });

    it('should call next() for empty path', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
      });

      const middleware = adapter.serve();
      const req = { path: '/' } as any;
      const res = { redirect: vi.fn() } as any;
      const next = vi.fn();
      middleware(req, res, next);

      expect(next).toHaveBeenCalledOnce();
      expect(res.redirect).not.toHaveBeenCalled();
    });
  });

  describe('urlToPath()', () => {
    it('should strip blob storage URL prefix', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });

      const result = adapter.urlToPath(
        'https://testaccount.blob.core.windows.net/ghost-content/2024/01/photo.jpg',
      );
      expect(result).toBe('2024/01/photo.jpg');
    });

    it('should strip custom domain URL prefix', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        customDomain: 'https://cdn.example.com',
      });

      const result = adapter.urlToPath('https://cdn.example.com/2024/01/photo.jpg');
      expect(result).toBe('2024/01/photo.jpg');
    });

    it('should strip content/images/ prefix from relative URLs', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });

      const result = adapter.urlToPath('/content/images/2024/01/photo.jpg');
      expect(result).toBe('2024/01/photo.jpg');
    });

    it('should strip content/media/ prefix when contentPath is media', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        contentPath: 'media',
      });

      const result = adapter.urlToPath('/content/media/2024/01/audio.mp3');
      expect(result).toBe('2024/01/audio.mp3');
    });

    it('should strip content/files/ prefix when contentPath is files', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        contentPath: 'files',
      });

      const result = adapter.urlToPath('/content/files/2024/01/doc.pdf');
      expect(result).toBe('2024/01/doc.pdf');
    });

    it('should strip content/images/ prefix from old absolute Azure URLs', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });

      const result = adapter.urlToPath(
        'https://testaccount.blob.core.windows.net/ghost-content/content/images/2024/01/photo.jpg',
      );
      expect(result).toBe('2024/01/photo.jpg');
    });

    it('should strip pathPrefix from the result', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
        pathPrefix: 'images',
      });

      const result = adapter.urlToPath(
        'https://testaccount.blob.core.windows.net/ghost-content/images/2024/01/photo.jpg',
      );
      expect(result).toBe('2024/01/photo.jpg');
    });

    it('should return url as-is if it does not match any known prefix', () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });

      const result = adapter.urlToPath('https://other.example.com/photo.jpg');
      expect(result).toBe('https://other.example.com/photo.jpg');
    });
  });

  describe('container auto-creation', () => {
    it('should call createIfNotExists on first operation', async () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });

      await adapter.exists('test.jpg');
      const container = mockClient._containers['ghost-content'];
      expect(container.createIfNotExists).toHaveBeenCalledWith({ access: 'blob' });
    });

    it('should only call createIfNotExists once across multiple operations', async () => {
      const mockClient = createMockBlobServiceClient();
      const adapter = new AzureBlobStorageAdapter({
        blobServiceClient: mockClient,
        container: 'ghost-content',
      });

      await adapter.exists('a.jpg');
      await adapter.exists('b.jpg');
      await adapter.read({ path: 'c.jpg' });

      const container = mockClient._containers['ghost-content'];
      expect(container.createIfNotExists).toHaveBeenCalledTimes(1);
    });
  });
});

describe('AzureImagesStorage', () => {
  it('should default to container "images" and contentPath "images"', async () => {
    const mockClient = createMockBlobServiceClient();
    const adapter = new AzureImagesStorage({ blobServiceClient: mockClient });

    const file = { name: 'photo.jpg', path: '/tmp/photo.jpg', type: 'image/jpeg' };
    const url = await adapter.save(file);

    expect(mockClient.getContainerClient).toHaveBeenCalledWith('images');
    expect(url).toMatch(/^\/content\/images\//);
  });

  it('should allow overriding container via config', async () => {
    const mockClient = createMockBlobServiceClient();
    const adapter = new AzureImagesStorage({
      blobServiceClient: mockClient,
      container: 'custom-images',
    });

    await adapter.exists('test.jpg');
    expect(mockClient.getContainerClient).toHaveBeenCalledWith('custom-images');
  });
});

describe('AzureMediaStorage', () => {
  it('should default to container "media" and contentPath "media"', async () => {
    const mockClient = createMockBlobServiceClient();
    const adapter = new AzureMediaStorage({ blobServiceClient: mockClient });

    const file = { name: 'episode.mp3', path: '/tmp/episode.mp3', type: 'audio/mpeg' };
    const url = await adapter.save(file);

    expect(mockClient.getContainerClient).toHaveBeenCalledWith('media');
    expect(url).toMatch(/^\/content\/media\//);
  });

  it('should allow overriding container via config', async () => {
    const mockClient = createMockBlobServiceClient();
    const adapter = new AzureMediaStorage({
      blobServiceClient: mockClient,
      container: 'custom-media',
    });

    await adapter.exists('test.mp3');
    expect(mockClient.getContainerClient).toHaveBeenCalledWith('custom-media');
  });
});

describe('AzureFilesStorage', () => {
  it('should default to container "files" and contentPath "files"', async () => {
    const mockClient = createMockBlobServiceClient();
    const adapter = new AzureFilesStorage({ blobServiceClient: mockClient });

    const file = { name: 'doc.pdf', path: '/tmp/doc.pdf', type: 'application/pdf' };
    const url = await adapter.save(file);

    expect(mockClient.getContainerClient).toHaveBeenCalledWith('files');
    expect(url).toMatch(/^\/content\/files\//);
  });

  it('should allow overriding container via config', async () => {
    const mockClient = createMockBlobServiceClient();
    const adapter = new AzureFilesStorage({
      blobServiceClient: mockClient,
      container: 'custom-files',
    });

    await adapter.exists('test.pdf');
    expect(mockClient.getContainerClient).toHaveBeenCalledWith('custom-files');
  });
});
