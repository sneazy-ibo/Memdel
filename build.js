import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });

const shared = {
    entryPoints: ['src/index.ts'],
    bundle: true,
    sourcemap: true,
    target: ['es2020'],
    logLevel: 'info'
};

await Promise.all([
    esbuild.build({
        ...shared,
        format: 'esm',
        outfile: 'dist/index.mjs',
        external: ['mediabunny']
    }),
    esbuild.build({
        ...shared,
        format: 'cjs',
        outfile: 'dist/index.js',
        external: ['mediabunny']
    }),

    esbuild.build({
        ...shared,
        format: 'iife',
        globalName: 'Memdel',
        outfile: 'dist/index.iife.js'
    }),
    esbuild.build({
        ...shared,
        format: 'iife',
        globalName: 'Memdel',
        outfile: 'dist/index.iife.min.js',
        minify: true,
        sourcemap: false
    })
]);
