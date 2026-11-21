/* SPDX-License-Identifier: AGPL-3.0-only */
#include "ocr_image.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { WIDTH = 360, HEIGHT = 130 };

static void rectangle(uint8_t *image, int x, int y, int width, int height, uint8_t value) {
    for (int row = y; row < y + height; row++)
        memset(image + row * WIDTH + x, value, (size_t)width);
}

static void letter(uint8_t *image, int x, int y) {
    rectangle(image, x, y, 20, 30, 16);
    rectangle(image, x + 3, y + 3, 14, 24, 220);
    rectangle(image, x + 7, y + 7, 6, 16, 16);
    // Scene detail visible through the counter of an outlined O.
    rectangle(image, x + 9, y + 10, 2, 10, 180);
}

static void release(struct subtitle_search *search) {
    free(search->seen);
    free(search->queue);
}

static void outlined_rows(void) {
    uint8_t image[WIDTH * HEIGHT], mask[WIDTH * HEIGHT];
    memset(image, 180, sizeof(image));
    for (int i = 0; i < 6; i++) letter(image, 100 + i * 28, 18);
    letter(image, 156, 65);
    letter(image, 184, 65);
    // Nearby smaller HUD text must not become a third subtitle row.
    for (int i = 0; i < 4; i++) {
        rectangle(image, 152 + i * 14, 105, 12, 18, 16);
        rectangle(image, 154 + i * 14, 107, 8, 14, 220);
    }
    struct subtitle_search search = {0};
    struct subtitle_layout layout = subtitle_focus(&search, image, WIDTH, HEIGHT, 1080, NULL, mask);
    assert(layout.lines == 2);
    assert(!layout.boxed);
    // The first letter starts at x=103, y=21. Outlined rows receive 22/4 px padding.
    int left = 103 - 22, top = 21 - 4;
    assert(mask[(size_t)(30 - top) * layout.width + (109 - left)] == 255);
    assert(mask[(size_t)(30 - top) * layout.width + (104 - left)] == 0);
    // The short second row survived.
    assert(mask[(size_t)(75 - top) * layout.width + (160 - left)] == 0);
    release(&search);
}

static void empty_and_boxed(void) {
    uint8_t image[WIDTH * HEIGHT], mask[WIDTH * HEIGHT];
    uint8_t blue[(WIDTH / 2) * ((HEIGHT + 1) / 2)];
    struct subtitle_search search = {0};
    memset(image, 40, sizeof(image));
    struct subtitle_layout layout = subtitle_focus(&search, image, WIDTH, HEIGHT, 1080, NULL, mask);
    assert(layout.lines == 0);
    for (int i = 0; i < 6; i++) letter(image, 100 + i * 28, 18);
    memset(blue, 1, sizeof(blue));
    struct subtitle_backdrop backdrop = {blue, WIDTH / 2, 0, 0};
    layout = subtitle_focus(&search, image, WIDTH, HEIGHT, 1080, &backdrop, mask);
    assert(layout.lines == 1);
    assert(layout.boxed);
    release(&search);
}

static void paint_panel(uint8_t *image, uint8_t *blue, int x, int y, int width, int height) {
    rectangle(image, x, y, width, height, 42);
    for (int row = y / 2; row < (y + height) / 2; row++)
        memset(blue + row * (WIDTH / 2) + x / 2, 1, (size_t)width / 2);
}

static void rectangle_first(void) {
    uint8_t image[WIDTH * HEIGHT], mask[WIDTH * HEIGHT], blue[(WIDTH / 2) * (HEIGHT / 2)];
    struct subtitle_search search = {0};
    const struct subtitle_backdrop backdrop = {blue, WIDTH / 2, 0, 0};
    memset(image, 158, sizeof(image));
    memset(blue, 0, sizeof(blue));
    paint_panel(image, blue, 124, 22, 112, 36);
    rectangle(image, 124, 22, 4, 2, 158);
    assert(subtitle_rectangle(&search, image, WIDTH, HEIGHT, 1080, &backdrop, mask).lines == 0);

    // Strokes below the ordinary fixed brightness threshold are still inside the panel.
    rectangle(image, 148, 31, 5, 18, 114);
    rectangle(image, 156, 31, 5, 18, 114);
    struct subtitle_layout one = subtitle_rectangle(&search, image, WIDTH, HEIGHT, 1080, &backdrop, mask);
    assert(one.boxed && one.lines == 1 && one.width == 106 && one.height == 30);
    assert(mask[(31 - 25) * one.width + 148 - 127] == 0);
    assert(mask[0] == 255);

    paint_panel(image, blue, 136, 64, 88, 36);
    rectangle(image, 150, 75, 6, 16, 120);
    rectangle(image, 160, 75, 6, 16, 120);
    struct subtitle_layout two = subtitle_rectangle(&search, image, WIDTH, HEIGHT, 1080, &backdrop, mask);
    assert(two.boxed && two.lines == 2);
    assert(mask[(75 - 25) * two.width + 150 - 127] == 0);
    assert(mask[(61 - 25) * two.width + 150 - 127] == 255);

    memset(image, 158, sizeof(image));
    memset(blue, 0, sizeof(blue));
    paint_panel(image, blue, 16, 22, 112, 36);
    rectangle(image, 36, 31, 14, 18, 215);
    paint_panel(image, blue, 124, 64, 112, 36);
    rectangle(image, 124, 64, 44, 18, 158);
    rectangle(image, 176, 74, 14, 18, 215);
    assert(subtitle_rectangle(&search, image, WIDTH, HEIGHT, 1080, &backdrop, mask).lines == 0);
    assert(subtitle_rectangle(&search, image, WIDTH, HEIGHT, 1080, NULL, mask).lines == 0);
    release(&search);
}

int main(void) {
    outlined_rows();
    empty_and_boxed();
    rectangle_first();
    puts("OCR image tests passed: outlined glyphs, solid boxes, two panels, dim text, empty panels and HUD exclusion.");
    return 0;
}
