/**
 * Draw a QR matrix on a canvas.
 *
 * The matrix arrives from the main process as plain 0/1 rows, so the renderer
 * needs no QR library and no bundler: it only paints squares.
 */
export function drawQr(canvas, matrix, options = {}) {
  if (!canvas || !matrix || !Array.isArray(matrix.modules) || matrix.modules.length === 0) {
    return false;
  }

  const quietZone = options.quietZone ?? 4;
  const scale = options.scale ?? 8;
  const background = options.background ?? '#ffffff';
  const foreground = options.foreground ?? '#000000';

  const size = matrix.size;
  const total = size + quietZone * 2;
  const pixels = total * scale;

  canvas.width = pixels;
  canvas.height = pixels;

  const context = canvas.getContext('2d');
  context.fillStyle = background;
  context.fillRect(0, 0, pixels, pixels);
  context.fillStyle = foreground;

  for (let row = 0; row < size; row += 1) {
    const line = matrix.modules[row];
    for (let column = 0; column < size; column += 1) {
      if (line[column]) {
        context.fillRect((column + quietZone) * scale, (row + quietZone) * scale, scale, scale);
      }
    }
  }

  return true;
}
