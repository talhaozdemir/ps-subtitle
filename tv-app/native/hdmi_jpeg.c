/* SPDX-License-Identifier: AGPL-3.0-only */
#include "hdmi_jpeg.h"
#include <stdio.h>
#include <jpeglib.h>
#include <setjmp.h>

struct jpeg_failure {
    struct jpeg_error_mgr base;
    jmp_buf recovery;
};

static void send_failure(j_common_ptr decoder) {
    struct jpeg_failure *failure = (struct jpeg_failure *)decoder->err;
    longjmp(failure->recovery, 1);
}

bool hdmi_decode_band(const uint8_t *source, size_t size, int x, int y, int right, int bottom,
        uint8_t *destination) {
    struct jpeg_decompress_struct decoder = {0};
    struct jpeg_failure failure;
    uint8_t row[HDMI_WIDTH];
    decoder.err = jpeg_std_error(&failure.base);
    failure.base.error_exit = send_failure;
    if (setjmp(failure.recovery)) {
        jpeg_destroy_decompress(&decoder);
        return false;
    }
    jpeg_create_decompress(&decoder);
    jpeg_mem_src(&decoder, source, size);
    bool ok = false;
    if (jpeg_read_header(&decoder, TRUE) != JPEG_HEADER_OK ||
            decoder.image_width != HDMI_WIDTH || decoder.image_height != HDMI_HEIGHT) goto done;
    decoder.out_color_space = JCS_GRAYSCALE;
    if (!jpeg_start_decompress(&decoder)) goto done;
    JDIMENSION left = x, width = right - x;
    jpeg_crop_scanline(&decoder, &left, &width);
    if (left > (JDIMENSION)x || left + width < (JDIMENSION)right || width > sizeof(row) ||
            decoder.output_width != width || decoder.output_components != 1) goto done;
    if (jpeg_skip_scanlines(&decoder, y) != (JDIMENSION)y) goto done;
    for (int line = y; line < bottom; ++line) {
        JSAMPROW scan = row;
        if (jpeg_read_scanlines(&decoder, &scan, 1) != 1) goto done;
        for (int column = x; column < right; ++column)
            *destination++ = (uint8_t)(16 + (row[column - left] * 219 + 127) / 255);
    }
    ok = true;
done:
    jpeg_destroy_decompress(&decoder);
    return ok;
}
