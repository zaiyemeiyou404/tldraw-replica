import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import path from 'node:path'

const viewRoot = path.resolve('src/view')

export default defineConfig({
	root: viewRoot,
	plugins: [react(), viteSingleFile()],
	build: {
		outDir: path.resolve('dist/view'),
		emptyOutDir: true,
		cssCodeSplit: false,
		assetsInlineLimit: 100000000,
		rollupOptions: {
			input: path.join(viewRoot, 'index.html'),
		},
	},
})
