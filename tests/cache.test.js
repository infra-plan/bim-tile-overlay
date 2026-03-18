import { describe, it, expect } from 'vitest';
import { createTileCache } from '../src/cache.js';

describe('createTileCache', () => {
    it('stores and retrieves values', () => {
        const cache = createTileCache(3);
        cache.put('a', { canvas: null, data: 1 });
        expect(cache.get('a')).toEqual({ canvas: null, data: 1 });
    });

    it('returns undefined for missing keys', () => {
        const cache = createTileCache(3);
        expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('reports correct size', () => {
        const cache = createTileCache(5);
        expect(cache.size()).toBe(0);
        cache.put('a', { canvas: null });
        cache.put('b', { canvas: null });
        expect(cache.size()).toBe(2);
    });

    it('evicts oldest entry when maxSize is reached', () => {
        const cache = createTileCache(2);
        cache.put('a', { canvas: null, data: 'first' });
        cache.put('b', { canvas: null, data: 'second' });
        cache.put('c', { canvas: null, data: 'third' });

        expect(cache.get('a')).toBeUndefined(); // Evicted
        expect(cache.get('b')).toBeDefined();
        expect(cache.get('c')).toBeDefined();
        expect(cache.size()).toBe(2);
    });

    it('moves accessed entry to most-recently-used position', () => {
        const cache = createTileCache(2);
        cache.put('a', { canvas: null, data: 'first' });
        cache.put('b', { canvas: null, data: 'second' });

        // Access 'a' to make it most recently used
        cache.get('a');

        // Adding 'c' should evict 'b' (now the oldest), not 'a'
        cache.put('c', { canvas: null, data: 'third' });

        expect(cache.get('a')).toBeDefined();
        expect(cache.get('b')).toBeUndefined(); // Evicted
        expect(cache.get('c')).toBeDefined();
    });

    it('zeros canvas dimensions on eviction to free GPU memory', () => {
        const cache = createTileCache(1);
        const mockCanvas = { width: 1024, height: 1024 };
        cache.put('a', { canvas: mockCanvas });

        // Evict 'a' by adding 'b'
        cache.put('b', { canvas: { width: 512, height: 512 } });

        expect(mockCanvas.width).toBe(0);
        expect(mockCanvas.height).toBe(0);
    });

    it('zeros canvas dimensions on clear', () => {
        const cache = createTileCache(5);
        const canvas1 = { width: 1024, height: 1024 };
        const canvas2 = { width: 512, height: 512 };
        cache.put('a', { canvas: canvas1 });
        cache.put('b', { canvas: canvas2 });

        cache.clear();

        expect(canvas1.width).toBe(0);
        expect(canvas1.height).toBe(0);
        expect(canvas2.width).toBe(0);
        expect(canvas2.height).toBe(0);
        expect(cache.size()).toBe(0);
    });

    it('handles entries without canvas property gracefully', () => {
        const cache = createTileCache(1);
        cache.put('a', { data: 'no canvas' });
        cache.put('b', { data: 'evict a' });

        // Should not throw even though 'a' has no canvas
        expect(cache.get('a')).toBeUndefined();
        expect(cache.get('b')).toBeDefined();
    });

    it('overwrites existing key without increasing size', () => {
        const cache = createTileCache(2);
        cache.put('a', { canvas: null, data: 'v1' });
        cache.put('a', { canvas: null, data: 'v2' });

        expect(cache.size()).toBe(1);
        expect(cache.get('a').data).toBe('v2');
    });

    it('uses default maxSize of 6', () => {
        const cache = createTileCache();
        for (let i = 0; i < 6; i++) {
            cache.put(`key${i}`, { canvas: null });
        }
        expect(cache.size()).toBe(6);

        // 7th entry should evict the first
        cache.put('key6', { canvas: null });
        expect(cache.size()).toBe(6);
        expect(cache.get('key0')).toBeUndefined();
    });
});
