import JSZip from 'jszip'

// A generated Office package can declare parts it never wrote. Office opens
// it anyway, but a strict reader refuses it, so a file Engram made would be
// refused by Engram's own copy step. Only declarations of absent parts go.
export async function withoutMissingParts(data: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(data)
  const types = zip.file('[Content_Types].xml')
  if (!types) return data
  const xml = await types.async('string')
  const kept = xml.replace(/<Override\b[^>]*\bPartName="([^"]+)"[^>]*\/>/g, (whole: string, part: string) => zip.file(part.replace(/^\//, '')) ? whole : '')
  if (kept === xml) return data
  zip.file('[Content_Types].xml', kept)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
