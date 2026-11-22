/* SPDX-License-Identifier: AGPL-3.0-only */
#include "ocr_image.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

enum { MAX_GLYPHS = 512, LIGHT_GLYPH = 126 };

struct bounds { int left, top, right, bottom; };
struct text_line { struct bounds box; int score; int backdrop_row; int glyph_height; };
struct line_search {
    const uint8_t *luma;
    const struct subtitle_backdrop *backdrop;
    int width, height, frame_height;
    bool outlined;
    bool allow_short;
};

static int min_int(int a, int b) { return a < b ? a : b; }
static int max_int(int a, int b) { return a > b ? a : b; }
static int scaled(int pixels, int frame_height) { return max_int(1, pixels * frame_height / 1080); }

static bool reserve_search(struct subtitle_search *search, size_t size) {
    if (size <= search->capacity) return true;
    uint8_t *seen = realloc(search->seen, size);
    if (!seen) return false;
    search->seen = seen;
    uint32_t *queue = realloc(search->queue, size * sizeof(*queue));
    if (!queue) return false;
    search->queue = queue;
    search->capacity = size;
    return true;
}

static size_t component(struct subtitle_search *search, const uint8_t *luma, int width,
        int height, uint32_t start, int threshold, struct bounds *box) {
    search->queue[0] = start;
    search->seen[start] = 1;
    size_t count = 1;
    for (size_t pos = 0; pos < count; pos++) {
        int x = (int)(search->queue[pos] % (unsigned int)width);
        int y = (int)(search->queue[pos] / (unsigned int)width);
        box->left = min_int(box->left, x);
        box->right = max_int(box->right, x + 1);
        box->top = min_int(box->top, y);
        box->bottom = max_int(box->bottom, y + 1);
        for (int row = max_int(0, y - 1); row <= min_int(height - 1, y + 1); row++) {
            for (int col = max_int(0, x - 1); col <= min_int(width - 1, x + 1); col++) {
                unsigned int next = (unsigned int)(row * width + col);
                if (luma[next] < threshold || search->seen[next]) continue;
                search->seen[next] = 1;
                search->queue[count++] = next;
            }
        }
    }
    return count;
}

static int by_left(const void *first, const void *second) {
    return ((const struct bounds *)first)->left - ((const struct bounds *)second)->left;
}

static void remove_counter_noise(struct subtitle_search *search, uint8_t *mask, int width, int height) {
    size_t size = (size_t)width * height, count = 0;
    memset(search->seen, 0, size);
    // Mark the paper around the letters. Paper inside a closed letter counter
    // stays unmarked, allowing us to discard scene specks inside an O, B, etc.
    for (size_t i = 0; i < size; i++) {
        if (mask[i] != 255) continue;
        int x = (int)(i % (size_t)width), y = (int)(i / (size_t)width);
        if (x && y && x != width - 1 && y != height - 1) continue;
        search->seen[i] = 1;
        search->queue[count++] = (uint32_t)i;
    }
    for (size_t pos = 0; pos < count; pos++) {
        uint32_t point = search->queue[pos];
        int x = (int)(point % (unsigned int)width), y = (int)(point / (unsigned int)width);
        const int dx[] = {-1, 1, 0, 0}, dy[] = {0, 0, -1, 1};
        for (int n = 0; n < 4; n++) {
            int col = x + dx[n], row = y + dy[n];
            if (col < 0 || col >= width || row < 0 || row >= height) continue;
            uint32_t next = (uint32_t)(row * width + col);
            if (mask[next] != 255 || search->seen[next]) continue;
            search->seen[next] = 1;
            search->queue[count++] = next;
        }
    }
    for (size_t i = 0; i < size; i++) {
        if (mask[i] || search->seen[i]) continue;
        count = 1;
        bool outside = false;
        search->queue[0] = (uint32_t)i;
        search->seen[i] = 2;
        for (size_t pos = 0; pos < count; pos++) {
            uint32_t point = search->queue[pos];
            int x = (int)(point % (unsigned int)width), y = (int)(point / (unsigned int)width);
            for (int row = max_int(0, y - 1); row <= min_int(height - 1, y + 1); row++) {
                for (int col = max_int(0, x - 1); col <= min_int(width - 1, x + 1); col++) {
                    uint32_t next = (uint32_t)(row * width + col);
                    if (mask[next] == 255) {
                        if (search->seen[next] == 1) outside = true;
                    } else if (!search->seen[next]) {
                        search->seen[next] = 2;
                        search->queue[count++] = next;
                    }
                }
            }
        }
        if (!outside) for (size_t j = 0; j < count; j++) mask[search->queue[j]] = 255;
    }
}

bool subtitle_blue_chroma(uint8_t u, uint8_t v) {
    // The game's solid navy panel has slightly elevated Cb and nearly neutral Cr.
    return u >= 130 && u <= 149 && v >= 116 && v <= 138 && (int)u - v >= 4 && (int)u - v <= 24;
}

static bool blue_pixel(const struct line_search *search, int x, int y) {
    const struct subtitle_backdrop *backdrop = search->backdrop;
    int luma = search->luma[(size_t)y * search->width + x];
    return luma >= 22 && luma <= 78 &&
        backdrop->blue[(size_t)((y + backdrop->y_phase) / 2) * backdrop->stride + (x + backdrop->x_phase) / 2];
}

static size_t blue_component(struct subtitle_search *search, const uint8_t *blue, int width, int height,
        uint32_t start, struct bounds *box) {
    search->queue[0] = start;
    search->seen[start] = 1;
    size_t count = 1;
    for (size_t i = 0; i < count; i++) {
        uint32_t point = search->queue[i];
        int x = (int)(point % (unsigned int)width), y = (int)(point / (unsigned int)width);
        box->left = min_int(box->left, x);
        box->right = max_int(box->right, x + 1);
        box->top = min_int(box->top, y);
        box->bottom = max_int(box->bottom, y + 1);
        for (int direction = 0; direction < 4; direction++) {
            const int dx[] = {-1, 1, 0, 0}, dy[] = {0, 0, -1, 1};
            int col = x + dx[direction], row = y + dy[direction];
            if (col < 0 || col >= width || row < 0 || row >= height) continue;
            uint32_t next = (uint32_t)(row * width + col);
            if (!blue[next] || search->seen[next]) continue;
            search->seen[next] = 1;
            search->queue[count++] = next;
        }
    }
    return count;
}

static int count_edge(const uint8_t *edge, int length, int stride) {
    int count = 0;
    for (int i = 0; i < length; i++) count += edge[(size_t)i * stride];
    return count;
}

static bool rectangular_edges(const uint8_t *blue, int stride, struct bounds box) {
    int width = box.right - box.left, height = box.bottom - box.top;
    const uint8_t *top = blue + (size_t)box.top * stride + box.left;
    const uint8_t *bottom = top + (size_t)(height - 1) * stride;
    const uint8_t *right = top + width - 1;
    if (5 * max_int(count_edge(top, width, 1), count_edge(top + stride, width, 1)) < 4 * width ||
            5 * max_int(count_edge(bottom, width, 1), count_edge(bottom - stride, width, 1)) < 4 * width ||
            4 * max_int(count_edge(top, height, stride), count_edge(top + 1, height, stride)) < 3 * height ||
            4 * max_int(count_edge(right, height, stride), count_edge(right - 1, height, stride)) < 3 * height)
        return false;

    // The inner edge can survive even when the outermost pixels have been rounded by compression.
    const uint8_t *corners[] = {top, right - 2, bottom - 2 * stride, bottom - 2 * stride + width - 3};
    for (size_t i = 0; i < sizeof(corners) / sizeof(*corners); i++) {
        int count = 0;
        for (int row = 0; row < 3; row++) count += count_edge(corners[i] + row * stride, 3, 1);
        if (count < 4) return false;
    }
    return true;
}

static int percentile(const int *histogram, int target) {
    for (int value = 0; value < 255; value++) {
        target -= histogram[value];
        if (target <= 0) return value;
    }
    return 255;
}

static int panel_threshold(const uint8_t *luma, int stride, struct bounds box) {
    int levels[256] = {0}, border[256] = {0};
    int width = box.right - box.left, height = box.bottom - box.top;
    for (int y = box.top; y < box.bottom; y++) {
        for (int x = box.left; x < box.right; x++) {
            uint8_t value = luma[(size_t)y * stride + x];
            levels[value]++;
            if (y == box.top || y == box.bottom - 1 || x == box.left || x == box.right - 1) border[value]++;
        }
    }
    int background = percentile(border, width + height - 2);
    int peak = percentile(levels, (985 * width * height + 999) / 1000);
    if (peak - background < 26) return 0;
    return max_int(75, background + (peak - background) * 45 / 100);
}

struct subtitle_layout subtitle_rectangle(struct subtitle_search *search, const uint8_t *luma,
        int width, int height, int frame_height, const struct subtitle_backdrop *backdrop, uint8_t *mask) {
    struct subtitle_layout layout = {0};
    if (!backdrop) return layout;
    const int sample_width = (width + 1) / 2, sample_height = (height + 1) / 2;
    size_t samples = (size_t)sample_width * sample_height;
    if (!reserve_search(search, samples)) return layout;
    struct line_search source = {luma, backdrop, width, height, frame_height, false, false};
    memset(search->seen, 0, samples);
    for (int y = 0; y < sample_height; y++) {
        for (int x = 0; x < sample_width; x++) mask[(size_t)y * sample_width + x] = blue_pixel(&source, 2 * x, 2 * y);
    }

    struct panel { struct bounds box; int threshold; } panels[8];
    int panel_count = 0, best = 0, best_distance = width;
    int inset = max_int(2, scaled(3, frame_height));
    for (uint32_t i = 0; i < samples; i++) {
        if (!mask[i] || search->seen[i]) continue;
        struct bounds cell = {sample_width, sample_height, 0, 0};
        size_t area = blue_component(search, mask, sample_width, sample_height, i, &cell);
        int w = cell.right - cell.left, h = cell.bottom - cell.top;
        int center = abs(cell.left + cell.right - sample_width);
        if (2 * w < scaled(54, frame_height) || 2 * h < max_int(8, scaled(20, frame_height)) ||
                2 * h > scaled(124, frame_height) || 2 * w < 3 * h || center > 2 * sample_width / 7 ||
                !cell.left || !cell.top || cell.right == sample_width || cell.bottom == sample_height ||
                100 * area < 55 * (size_t)w * h || !rectangular_edges(mask, sample_width, cell)) continue;

        struct bounds panel = {2 * cell.left + inset, 2 * cell.top + inset,
            2 * cell.right - inset, 2 * cell.bottom - inset};
        int threshold = panel_threshold(luma, width, panel);
        if (!threshold) continue;
        if (panel_count == (int)(sizeof(panels) / sizeof(*panels))) return layout;
        if (center < best_distance) {
            best_distance = center;
            best = panel_count;
        }
        panels[panel_count++] = (struct panel){panel, threshold};
    }
    if (!panel_count) return layout;

    struct panel primary = panels[best];
    struct panel secondary = {0};
    int nearest_gap = scaled(24, frame_height) + 1;
    for (int i = 0; i < panel_count; i++) {
        struct bounds other = panels[i].box;
        int gap = max_int(other.top - primary.box.bottom, primary.box.top - other.bottom);
        int center_delta = abs(other.left + other.right - primary.box.left - primary.box.right) / 2;
        if (gap < 0 || gap >= nearest_gap || center_delta > scaled(18, frame_height)) continue;
        secondary = panels[i];
        nearest_gap = gap;
    }

    struct bounds region = primary.box;
    if (secondary.threshold) {
        region.left = min_int(region.left, secondary.box.left);
        region.top = min_int(region.top, secondary.box.top);
        region.right = max_int(region.right, secondary.box.right);
        region.bottom = max_int(region.bottom, secondary.box.bottom);
    }
    layout.width = region.right - region.left;
    layout.height = region.bottom - region.top;
    layout.lines = secondary.threshold || layout.height + 2 * inset > scaled(54, frame_height) ? 2 : 1;
    layout.boxed = true;
    memset(mask, 255, (size_t)layout.width * layout.height);
    const struct panel rows[] = {primary, secondary};
    for (size_t i = 0; i < sizeof(rows) / sizeof(*rows); i++) {
        struct bounds row = rows[i].box;
        for (int y = row.top; y < row.bottom; y++) {
            for (int x = row.left; x < row.right; x++) {
                if (luma[(size_t)y * width + x] >= rows[i].threshold)
                    mask[(size_t)(y - region.top) * layout.width + x - region.left] = 0;
            }
        }
    }
    return layout;
}

static int count_blue(const struct line_search *search, struct bounds box, int y) {
    int count = 0, low = 255, high = 0;
    for (int col = 0; col < 8; col++) {
        int x = box.left + (box.right - box.left) * (2 * col + 1) / 16;
        if (!blue_pixel(search, x, y)) continue;
        int luma = search->luma[(size_t)y * search->width + x];
        low = min_int(low, luma);
        high = max_int(high, luma);
        count++;
    }
    return high - low <= 18 ? count : 0;
}

static int find_backdrop_row(const struct line_search *search, struct bounds box) {
    if (!search->backdrop) return -1;
    const int offsets[] = {-2, -1, 1, 7, 9, 10};
    int best_y = -1, best = 0, total = 0, strong_rows = 0;
    for (size_t i = 0; i < sizeof(offsets) / sizeof(*offsets); i++) {
        int y = box.top + (box.bottom - box.top) * offsets[i] / 8;
        if (y < 0 || y >= search->height) continue;
        int count = count_blue(search, box, y);
        total += count;
        if (count >= 6) strong_rows++;
        if (count > best) { best = count; best_y = y; }
    }
    return strong_rows >= 2 && total >= 17 ? best_y : -1;
}

static void rank_line(const struct line_search *search, struct text_line *best, struct bounds box,
        int letters, int height_sum, const struct text_line *rows, int row_count) {
    int frame_height = search->frame_height;
    int span = box.right - box.left;
    if (letters < 2 || span < scaled(22, frame_height)) return;
    int center_delta = abs(box.left + box.right - search->width) / 2;
    if (center_delta > search->width / 7) return;
    int backdrop_row = find_backdrop_row(search, box);
    bool boxed = backdrop_row >= 0;
    bool short_row = (row_count && search->outlined) ||
        (search->allow_short && center_delta <= search->width / 16);
    if (!boxed && !short_row && (letters < 4 || span < scaled(62, frame_height))) return;
    int score = 4 * letters + span / scaled(42, frame_height) - center_delta / scaled(17, frame_height);
    if (score < (boxed || short_row ? 6 : 12)) return;
    bool best_boxed = best->backdrop_row >= 0;
    if (best->score && ((best_boxed && !boxed) || (best_boxed == boxed && score <= best->score))) return;
    if (row_count) {
        int glyph_height = height_sum / letters;
        int first_height = rows[0].glyph_height;
        if (search->outlined && (glyph_height * 4 < first_height * 3 || glyph_height * 3 > first_height * 4)) return;
        int nearest = search->height;
        for (int i = 0; i < row_count; i++) {
            int separation = abs(box.top + box.bottom - rows[i].box.top - rows[i].box.bottom) / 2;
            if (separation < scaled(22, frame_height)) return;
            nearest = min_int(nearest, separation);
        }
        if (nearest > scaled(65, frame_height) || (rows[0].backdrop_row >= 0 && !boxed)) return;
        if (!search->outlined && score * 3 < rows[0].score) return;
    }
    *best = (struct text_line){box, score, backdrop_row, height_sum / letters};
}

static struct text_line find_line(const struct line_search *search, const struct bounds *glyphs, size_t count,
        const struct text_line *rows, int row_count) {
    struct text_line best = {0};
    int baseline_tolerance = scaled(8, search->frame_height);
    int word_gap = scaled(86, search->frame_height);
    for (size_t anchor = 0; anchor < count; anchor++) {
        struct bounds box = {0};
        int letters = 0, height_sum = 0;
        for (size_t i = 0; i < count; i++) {
            struct bounds glyph = glyphs[i];
            if (abs(glyph.bottom - glyphs[anchor].bottom) > baseline_tolerance) continue;
            if (letters && glyph.left - box.right > word_gap) {
                rank_line(search, &best, box, letters, height_sum, rows, row_count);
                letters = 0;
                height_sum = 0;
            }
            if (!letters) box = glyph;
            else {
                box.right = max_int(box.right, glyph.right);
                box.top = min_int(box.top, glyph.top);
                box.bottom = max_int(box.bottom, glyph.bottom);
            }
            letters++;
            height_sum += glyph.bottom - glyph.top;
        }
        rank_line(search, &best, box, letters, height_sum, rows, row_count);
    }
    return best;
}

static struct bounds pad_line(const struct line_search *search, struct text_line line, bool outlined) {
    struct bounds box = line.box;
    int x_pad = scaled(22, search->frame_height), y_pad = scaled(outlined ? 4 : 13, search->frame_height);
    struct bounds limit = {max_int(0, box.left - x_pad), max_int(0, box.top - y_pad),
        min_int(search->width, box.right + x_pad), min_int(search->height, box.bottom + y_pad)};
    if (line.backdrop_row < 0) return limit;
    while (box.left > limit.left && blue_pixel(search, box.left - 1, line.backdrop_row)) box.left--;
    while (box.right < limit.right && blue_pixel(search, box.right, line.backdrop_row)) box.right++;
    while (box.top > limit.top && count_blue(search, line.box, box.top - 1) >= 4) box.top--;
    while (box.bottom < limit.bottom && count_blue(search, line.box, box.bottom) >= 4) box.bottom++;
    return box;
}

static void record_mark(const struct line_search *search, struct bounds box, const uint8_t *mask,
        struct subtitle_mark *mark) {
    int width = search->width;
    int radius = scaled(4, search->frame_height);
    int left = max_int(radius, box.left - radius);
    int right = min_int(width - radius, box.right + radius);
    int row_height = box.bottom - box.top;
    for (int y = box.top; y < box.bottom; y++) {
        int row = (y - box.top) * SUBTITLE_MARK_ROWS / row_height;
        for (int x = left; x < right; x++) {
            size_t point = (size_t)y * width + x;
            const uint8_t *pixel = search->luma + point;
            int outline = min_int(pixel[-radius], pixel[radius]);
            if (mask[point] || *pixel - outline < 34) continue;
            int col = x * SUBTITLE_MARK_COLUMNS / width;
            uint8_t *ink = &mark->ink[row * SUBTITLE_MARK_COLUMNS + col];
            if (*ink < 32) (*ink)++;
        }
    }
}

static struct subtitle_layout focus_pass(struct subtitle_search *search, const uint8_t *luma,
        int width, int height, int frame_height, const struct subtitle_backdrop *backdrop,
        int threshold, bool outlined, uint8_t *mask, bool candidates_only, struct subtitle_mark *mark) {
    struct subtitle_layout layout = {0};
    size_t size = (size_t)width * height;
    if (!reserve_search(search, size)) return layout;
    memset(search->seen, 0, size);
    memset(mask, 255, size);
    struct bounds glyphs[MAX_GLYPHS];
    size_t glyph_count = 0;
    for (uint32_t i = 0; i < size; i++) {
        if (luma[i] < threshold || search->seen[i]) continue;
        struct bounds box = { width, height, 0, 0 };
        size_t pixels = component(search, luma, width, height, i, threshold, &box);
        int glyph_width = box.right - box.left;
        int glyph_height = box.bottom - box.top;
        if (pixels < 2 || glyph_width > scaled(64, frame_height) || glyph_height > scaled(48, frame_height)) continue;
        if (outlined && (box.left == 0 || box.top == 0 || box.right == width || box.bottom == height)) continue;
        int fill_threshold = threshold;
        if (outlined) {
            int peak = 0;
            for (size_t j = 0; j < pixels; j++) peak = max_int(peak, luma[search->queue[j]]);
            if (peak < 110) continue;
            // The dark outline separates each glyph from the scene. Threshold its fill
            // relative to its own brightness so coloured speaker names survive too.
            fill_threshold = max_int(100, peak * 65 / 100);
        }
        for (size_t j = 0; j < pixels; j++) {
            uint32_t point = search->queue[j];
            if (luma[point] >= fill_threshold) mask[point] = 0;
        }
        // Restrict anchors to letter-sized components; smaller dots are kept in the final crop.
        if (glyph_height >= scaled(12, frame_height) && glyph_height <= scaled(47, frame_height) &&
                glyph_width >= 2 && glyph_width <= min_int(scaled(60, frame_height), 2 * glyph_height) &&
                pixels >= (size_t)max_int(scaled(12, frame_height), glyph_height)) {
            if (glyph_count == MAX_GLYPHS) return layout;
            glyphs[glyph_count++] = box;
        }
    }
    if (outlined) {
        remove_counter_noise(search, mask, width, height);
        size_t kept = 0;
        for (size_t i = 0; i < glyph_count; i++) {
            struct bounds box = glyphs[i];
            bool ink = false;
            for (int y = box.top; y < box.bottom && !ink; y++) {
                for (int x = box.left; x < box.right; x++) {
                    if (!mask[(size_t)y * width + x]) { ink = true; break; }
                }
            }
            if (ink) glyphs[kept++] = box;
        }
        glyph_count = kept;
    }
    qsort(glyphs, glyph_count, sizeof(*glyphs), by_left);
    struct line_search line_search = {luma, backdrop, width, height, frame_height, outlined, candidates_only};
    struct text_line rows[3];
    rows[0] = find_line(&line_search, glyphs, glyph_count, NULL, 0);
    if (!rows[0].score) return layout;
    layout.lines = 1;
    if (mark) record_mark(&line_search, rows[0].box, mask, mark);
    if (candidates_only) return layout;
    for (int i = 1; i < (outlined ? 3 : 2); i++) {
        rows[i] = find_line(&line_search, glyphs, glyph_count, rows, i);
        if (!rows[i].score) break;
        layout.lines++;
    }
    layout.boxed = rows[0].backdrop_row >= 0;
    struct bounds crop = { width, height, 0, 0 };
    for (int i = 0; i < layout.lines; i++) {
        struct bounds *row = &rows[i].box;
        *row = pad_line(&line_search, rows[i], outlined);
        crop.left = min_int(crop.left, row->left);
        crop.right = max_int(crop.right, row->right);
        crop.top = min_int(crop.top, row->top);
        crop.bottom = max_int(crop.bottom, row->bottom);
    }
    layout.width = crop.right - crop.left;
    layout.height = crop.bottom - crop.top;
    // Pack the selected rows at the start of the same buffer, leaving everything else white.
    for (int y = crop.top; y < crop.bottom; y++) {
        for (int x = crop.left; x < crop.right; x++) {
            bool inside = false;
            for (int i = 0; i < layout.lines; i++) {
                struct bounds row = rows[i].box;
                if (x >= row.left && x < row.right && y >= row.top && y < row.bottom) inside = true;
            }
            mask[(size_t)(y - crop.top) * layout.width + x - crop.left] = inside ? mask[(size_t)y * width + x] : 255;
        }
    }
    return layout;
}

struct subtitle_layout subtitle_outline(struct subtitle_search *search, const uint8_t *luma,
        int width, int height, int frame_height, uint8_t *mask) {
    if (frame_height < 900) return (struct subtitle_layout){0};
    return focus_pass(search, luma, width, height, frame_height, NULL, 85, true, mask, false, NULL);
}

struct subtitle_layout subtitle_focus(struct subtitle_search *search, const uint8_t *luma,
        int width, int height, int frame_height, const struct subtitle_backdrop *backdrop, uint8_t *mask) {
    struct subtitle_layout layout;
    if (backdrop) {
        layout = focus_pass(search, luma, width, height, frame_height, backdrop, LIGHT_GLYPH, false, mask, false, NULL);
        if (layout.boxed) return layout;
    }
    if (frame_height < 900)
        return focus_pass(search, luma, width, height, frame_height, backdrop, LIGHT_GLYPH, false, mask, false, NULL);
    layout = focus_pass(search, luma, width, height, frame_height, NULL, 50, true, mask, false, NULL);
    if (layout.lines) return layout;
    return focus_pass(search, luma, width, height, frame_height, backdrop, LIGHT_GLYPH, false, mask, false, NULL);
}

bool subtitle_candidate(struct subtitle_search *search, const uint8_t *luma, int width,
        int height, int frame_height, uint8_t *mask) {
    return subtitle_candidate_mark(search, luma, width, height, frame_height, mask, NULL);
}

bool subtitle_candidate_mark(struct subtitle_search *search, const uint8_t *luma, int width,
        int height, int frame_height, uint8_t *mask, struct subtitle_mark *mark) {
    if (mark) memset(mark, 0, sizeof(*mark));
    if (focus_pass(search, luma, width, height, frame_height, NULL, LIGHT_GLYPH, false, mask, true, mark).lines)
        return true;
    return frame_height >= 900 &&
        focus_pass(search, luma, width, height, frame_height, NULL, 85, true, mask, true, mark).lines > 0;
}

bool subtitle_same_mark(const struct subtitle_mark *first, const struct subtitle_mark *second) {
    unsigned int difference = 0, total = 0;
    for (size_t index = 0; index < sizeof(first->ink); index++) {
        int a = first->ink[index], b = second->ink[index];
        difference += (unsigned int)abs(a - b);
        total += (unsigned int)max_int(a, b);
    }
    return total && difference * 100 <= total * 42;
}

void subtitle_band(int height, int frame_height, int *top, int *bottom) {
    // The user-selected ROI is already the subtitle band. An inner fixed band
    // can cut off wrapped rows even while a middle row remains detectable.
    (void)frame_height;
    *top = 0;
    *bottom = height;
}

static bool dark_nearby(const uint8_t *pixel, int step, int radius, int threshold) {
    for (int distance = 1; distance <= radius; distance++) {
        if (pixel[step * distance] <= threshold) return true;
    }
    return false;
}

static bool dark_background(const uint8_t *pixel, int step, int radius, int threshold) {
    return dark_nearby(pixel, -step, radius, threshold) && dark_nearby(pixel, step, radius, threshold);
}

void subtitle_mask(const uint8_t *luma, int width, int height, int radius, uint8_t *mask) {
    memset(mask, 255, (size_t)width * height);
    for (int y = radius; y < height - radius; y++) {
        for (int x = radius; x < width - radius; x++) {
            int index = y * width + x;
            const uint8_t *pixel = luma + index;
            if (*pixel < 100) continue;
            int threshold = *pixel - 35;
            if (threshold > 125) threshold = 125;
            // A thin bright stroke has dark pixels on both sides; a scene edge usually has one.
            if (dark_background(pixel, 1, radius, threshold) ||
                    dark_background(pixel, width, radius, threshold))
                mask[index] = 0;
        }
    }
}

void subtitle_image(const uint8_t *mask, int width, int height, int scale, uint8_t *image) {
    int stride = width * scale + 2 * OCR_BORDER;
    memset(image, 255, (size_t)stride * (height * scale + 2 * OCR_BORDER));
    for (int y = 0; y < height; y++) {
        const uint8_t *source = mask + (size_t)y * width;
        uint8_t *target = image + (size_t)(y * scale + OCR_BORDER) * stride + OCR_BORDER;
        if (scale == 1) {
            memcpy(target, source, (size_t)width);
        } else {
            for (int x = 0; x < width; x++) target[2 * x] = target[2 * x + 1] = source[x];
            memcpy(target + stride, target, (size_t)width * scale);
        }
    }
}
