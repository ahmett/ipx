import Sharp from 'sharp'
import defu from 'defu'
import imageMeta from 'image-meta'
import { hasProtocol } from 'ufo'
import type { Source, SourceData } from './types'
import { createFilesystemSource, createHTTPSource } from './sources'
import { applyHandler } from './handlers'
import { cachedPromise, getEnv, createError } from './utils'

// TODO: Move to image-meta
export interface ImageMeta {
  width: number
  height: number
  type: string
  mimeType: string
}

export interface IPXInputOptions {
  source?: string
  modifiers?: Record<string, string>
}

export interface IPXCTX {
  sources: Record<string, Source>
}

export type IPX = (id: string, opts?: IPXInputOptions) => {
  src: () => Promise<SourceData>,
  data: () => Promise<{
    data: Buffer,
    meta: ImageMeta,
    format: string
  }>
}

export interface IPXOptions {
  dir?: false | string
  domains?: false | string[]
  // TODO: Create types
  // https://github.com/lovell/sharp/blob/master/lib/constructor.js#L130
  sharp?: { [key: string]: any }
}

// https://sharp.pixelplumbing.com/#formats
// (gif and svg are not supported as output)
const SUPPORTED_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'tiff']

export function createIPX (userOptions: Partial<IPXOptions>): IPX {
  const defaults = {
    dir: getEnv('IPX_DIR', '.'),
    domains: getEnv('IPX_DOMAINS', []),
    sharp: {}
  }
  const options: IPXOptions = defu(userOptions, defaults) as IPXOptions

  const ctx: IPXCTX = {
    sources: {}
  }

  // Init sources
  if (options.dir) {
    ctx.sources.filesystem = createFilesystemSource({
      dir: options.dir
    })
  }
  if (options.domains) {
    ctx.sources.http = createHTTPSource({
      domains: options.domains
    })
  }

  return function ipx (id, inputOpts: IPXInputOptions = {}) {
    if (!id) {
      throw createError('resource id is missing', 400)
    }

    const modifiers = inputOpts.modifiers || {}

    const getSrc = cachedPromise(() => {
      const source = inputOpts.source || hasProtocol(id) ? 'http' : 'filesystem'
      if (!ctx.sources[source]) {
        throw createError('Unknown source: ' + source, 400)
      }
      return ctx.sources[source](id)
    })

    const getData = cachedPromise(async () => {
      const src = await getSrc()
      const data = await src.getData()

      // Extract source meta
      const meta = imageMeta(data) as ImageMeta

      // Determine format
      const mFormat = modifiers.f || modifiers.format
      let format = mFormat || meta.type
      if (format === 'jpg') {
        format = 'jpeg'
      }
      // Use original svg if format not specified
      if (meta.type === 'svg' && !mFormat) {
        return {
          data,
          format: 'svg',
          meta
        }
      }

      let sharp = Sharp(data)
      Object.assign((sharp as any).options, options.sharp)

      // Apply modifiers
      const modifierCtx: any = {}
      for (const key in inputOpts.modifiers) {
        sharp = applyHandler(modifierCtx, sharp, key, inputOpts.modifiers[key]) || sharp
      }

      // Apply format
      if (SUPPORTED_FORMATS.includes(format)) {
        sharp = sharp.toFormat(format as any, {
          quality: modifierCtx.quality,
          progressive: format === 'jpeg'
        })
      }

      // Convert to buffer
      const newData = await sharp.toBuffer()

      return {
        data: newData,
        format,
        meta
      }
    })

    return {
      src: getSrc,
      data: getData
    }
  }
}
