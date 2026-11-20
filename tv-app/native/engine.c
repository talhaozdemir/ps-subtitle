/* SPDX-License-Identifier: AGPL-3.0-only */
#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <limits.h>
#include <net/if.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include <chiaki/discoveryservice.h>
#include <chiaki/regist.h>
#include <chiaki/session.h>
#include <json-c/json.h>
#include <tesseract/capi.h>
#include <wels/codec_api.h>

enum { QUEUE_SIZE = 12, MAX_WIDTH = 1280, MAX_HEIGHT = 720, MAX_PIXELS = MAX_WIDTH * MAX_HEIGHT };

struct region {
    int x;
    int y;
    int width;
    int height;
    int revision;
};

static const struct region default_region = { .x = 6, .y = 77, .width = 88, .height = 23 };

struct packet {
    uint8_t *bytes;
    size_t size;
};

struct crop {
    uint8_t pixels[MAX_PIXELS];
    int width;
    int height;
    int revision;
};

struct engine {
    ChiakiSession session;
    ChiakiLog log;
    ISVCDecoder *decoder;
    TessBaseAPI *ocr;
    pthread_mutex_t mutex;
    pthread_cond_t packet_ready;
    pthread_cond_t crop_ready;
    struct packet packets[QUEUE_SIZE];
    size_t head;
    size_t count;
    struct region region;
    struct crop crop;
    bool has_crop;
    atomic_bool done;
    atomic_bool registered;
};

static uint64_t milliseconds(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
}

static void emit(struct json_object *value) {
    flockfile(stdout);
    fputs(json_object_to_json_string_ext(value, JSON_C_TO_STRING_PLAIN), stdout);
    fputc('\n', stdout);
    fflush(stdout);
    funlockfile(stdout);
    json_object_put(value);
}

static struct json_object *event(const char *type) {
    struct json_object *value = json_object_new_object();
    json_object_object_add(value, "type", json_object_new_string(type));
    return value;
}

static void message(const char *type, const char *text) {
    struct json_object *value = event(type);
    json_object_object_add(value, "text", json_object_new_string(text));
    emit(value);
}

static const char *field(struct json_object *input, const char *name) {
    struct json_object *value;
    if (!json_object_object_get_ex(input, name, &value) ||
        json_object_get_type(value) != json_type_string) return "";
    return json_object_get_string(value);
}

static int nonnegative_int(struct json_object *input, const char *name) {
    struct json_object *value;
    if (!json_object_object_get_ex(input, name, &value) || !json_object_is_type(value, json_type_int))
        return -1;
    int64_t number = json_object_get_int64(value);
    return number >= 0 && number <= INT_MAX ? (int)number : -1;
}

static bool parse_region(struct json_object *input, struct region *region) {
    struct json_object *rectangle;
    if (!json_object_object_get_ex(input, "region", &rectangle) ||
        !json_object_is_type(rectangle, json_type_object))
        return false;
    struct region next = {
        .x = nonnegative_int(rectangle, "x"),
        .y = nonnegative_int(rectangle, "y"),
        .width = nonnegative_int(rectangle, "width"),
        .height = nonnegative_int(rectangle, "height"),
        .revision = nonnegative_int(input, "revision"),
    };
    if (next.width < 10 || next.height < 5 || next.revision < 0 ||
        next.x < 0 || next.y < 0 || next.x > 100 - next.width || next.y > 100 - next.height)
        return false;
    *region = next;
    return true;
}

static bool receive_region_update(struct engine *engine) {
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
    int result = poll(&input, 1, 100);
    if (result <= 0) return result == 0 || errno == EINTR;
    if (!(input.revents & POLLIN)) return false;

    char line[512];
    if (!fgets(line, sizeof(line), stdin)) return false;
    struct json_object *command = json_tokener_parse(line);
    struct region next;
    if (command && parse_region(command, &next)) {
        pthread_mutex_lock(&engine->mutex);
        if (next.revision > engine->region.revision) {
            engine->region = next;
            engine->has_crop = false;
        }
        pthread_mutex_unlock(&engine->mutex);
    }
    if (command) json_object_put(command);
    return true;
}

static bool from_hex(const char *input, uint8_t *result, size_t size) {
    if (strlen(input) != size * 2) return false;
    const char digits[] = "0123456789abcdef";
    for (size_t index = 0; index < size; index++) {
        const char *upper = strchr(digits, input[index * 2]);
        const char *lower = strchr(digits, input[index * 2 + 1]);
        if (!upper || !lower) return false;
        result[index] = (uint8_t)(((upper - digits) << 4) | (lower - digits));
    }
    return true;
}

static void add_hex(struct json_object *value, const char *name, const uint8_t *bytes, size_t size) {
    char text[65];
    const char digits[] = "0123456789abcdef";
    if (size * 2 >= sizeof(text)) return;
    for (size_t index = 0; index < size; index++) {
        text[index * 2] = digits[bytes[index] >> 4];
        text[index * 2 + 1] = digits[bytes[index] & 15];
    }
    text[size * 2] = '\0';
    json_object_object_add(value, name, json_object_new_string(text));
}

static void registration_event(ChiakiRegistEvent *result, void *context) {
    struct engine *engine = context;
    if (result->type == CHIAKI_REGIST_EVENT_TYPE_FINISHED_SUCCESS && result->registered_host) {
        const ChiakiRegisteredHost *host = result->registered_host;
        struct json_object *value = event("paired");
        add_hex(value, "registKey", (const uint8_t *)host->rp_regist_key, sizeof(host->rp_regist_key));
        add_hex(value, "rpKey", host->rp_key, sizeof(host->rp_key));
        add_hex(value, "consoleId", host->server_mac, sizeof(host->server_mac));
        emit(value);
    } else {
        message("error", "PS5 eşleştirmeyi kabul etmedi. İkinci hesabı, IP adresini ve yeni eşleştirme kodunu kontrol et.");
    }
    atomic_store(&engine->registered, true);
}

static bool stdin_closed(int wait_ms) {
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN };
    return poll(&input, 1, wait_ms) > 0 && input.revents != 0;
}

static size_t interface_broadcasts(struct sockaddr_storage *addresses, size_t capacity) {
    struct ifaddrs *interfaces;
    if (getifaddrs(&interfaces) != 0) return 0;
    size_t count = 0;
    for (const struct ifaddrs *it = interfaces; it && count < capacity; it = it->ifa_next) {
        if (!it->ifa_addr || it->ifa_addr->sa_family != AF_INET || !it->ifa_broadaddr ||
            !(it->ifa_flags & IFF_UP) || !(it->ifa_flags & IFF_BROADCAST) || (it->ifa_flags & IFF_LOOPBACK)) continue;
        const struct sockaddr_in *broadcast = (const struct sockaddr_in *)it->ifa_broadaddr;
        if (broadcast->sin_addr.s_addr == INADDR_ANY || broadcast->sin_addr.s_addr == INADDR_BROADCAST) continue;
        memcpy(&addresses[count++], broadcast, sizeof(*broadcast));
    }
    freeifaddrs(interfaces);
    return count;
}

static void discovered_hosts(ChiakiDiscoveryHost *hosts, size_t count, void *context) {
    struct json_object **consoles = context;
    struct json_object *list = json_object_new_array();
    for (size_t i = 0; i < count; i++) {
        ChiakiDiscoveryHost *host = &hosts[i];
        struct in_addr ip;
        if (!chiaki_discovery_host_is_ps5(host) || host->state == CHIAKI_DISCOVERY_HOST_STATE_UNKNOWN ||
            !host->host_addr || inet_pton(AF_INET, host->host_addr, &ip) != 1 ||
            !host->host_id || strlen(host->host_id) != 12 ||
            strspn(host->host_id, "0123456789abcdefABCDEF") != 12) continue;
        const char *name = host->host_name ? host->host_name : "";
        struct json_object *console = json_object_new_object();
        json_object_object_add(console, "id", json_object_new_string(host->host_id));
        json_object_object_add(console, "address", json_object_new_string(host->host_addr));
        json_object_object_add(console, "name", json_object_new_string_len(name, strnlen(name, 60)));
        json_object_object_add(console, "ready", json_object_new_boolean(host->state == CHIAKI_DISCOVERY_HOST_STATE_READY));
        json_object_array_add(list, console);
    }
    json_object_put(*consoles);
    *consoles = list;
}

static int discover_consoles(void) {
    ChiakiLog log;
    chiaki_log_init(&log, 0, NULL, NULL);
    struct sockaddr_in all = { .sin_family = AF_INET, .sin_addr = { .s_addr = INADDR_BROADCAST } };
    struct sockaddr_storage target = { 0 };
    memcpy(&target, &all, sizeof(all));
    struct sockaddr_storage broadcasts[8] = { 0 };
    struct json_object *consoles = json_object_new_array();
    ChiakiDiscoveryServiceOptions options = {
        .hosts_max = 16, .host_drop_pings = 4, .ping_ms = 500, .ping_initial_ms = 100,
        .send_addr = &target, .send_addr_size = sizeof(all),
        .broadcast_addrs = broadcasts, .broadcast_num = interface_broadcasts(broadcasts, 8),
        .cb = discovered_hosts, .cb_user = &consoles
    };
    ChiakiDiscoveryService discovery;
    if (chiaki_discovery_service_init(&discovery, &options, &log) != CHIAKI_ERR_SUCCESS) {
        json_object_put(consoles);
        message("error", "PS5 ağ araması başlatılamadı.");
        return 1;
    }
    uint64_t deadline = milliseconds() + 1800;
    while (milliseconds() < deadline && !stdin_closed(50)) {}
    chiaki_discovery_service_fini(&discovery);
    struct json_object *result = event("discovered");
    json_object_object_add(result, "consoles", consoles);
    emit(result);
    return 0;
}

static int pair_console(struct engine *engine, struct json_object *input, const char *address) {
    ChiakiRegist registration;
    ChiakiRegistInfo info = { .target = CHIAKI_TARGET_PS5_1, .host = address, .broadcast = false };
    const char *pin = field(input, "pin");
    if (strlen(pin) != 8 || strspn(pin, "0123456789") != 8 ||
        !from_hex(field(input, "account"), info.psn_account_id, sizeof(info.psn_account_id))) {
        message("error", "PSN hesap kimliği veya eşleştirme kodu geçersiz.");
        return 1;
    }
    info.pin = (uint32_t)strtoul(pin, NULL, 10);
    if (chiaki_regist_start(&registration, &engine->log, &info, registration_event, engine) != CHIAKI_ERR_SUCCESS) {
        message("error", "PS5 eşleştirmesi başlatılamadı.");
        return 1;
    }
    uint64_t deadline = milliseconds() + 35000;
    while (!atomic_load(&engine->registered) && milliseconds() < deadline && !stdin_closed(50)) {}
    if (!atomic_load(&engine->registered)) {
        message("error", "PS5 eşleştirmesi zaman aşımına uğradı.");
        chiaki_regist_stop(&registration);
    }
    chiaki_regist_fini(&registration);
    return 0;
}

static bool video_packet(uint8_t *data, size_t size, int32_t lost, bool recovered, void *context) {
    (void)lost;
    (void)recovered;
    struct engine *engine = context;
    if (!size || size > 1024 * 1024 || atomic_load(&engine->done)) return false;
    pthread_mutex_lock(&engine->mutex);
    if (engine->count == QUEUE_SIZE) {
        pthread_mutex_unlock(&engine->mutex);
        return false;
    }
    uint8_t *bytes = malloc(size);
    if (!bytes) {
        pthread_mutex_unlock(&engine->mutex);
        return false;
    }
    memcpy(bytes, data, size);
    engine->packets[(engine->head + engine->count) % QUEUE_SIZE] = (struct packet){ bytes, size };
    engine->count++;
    pthread_cond_signal(&engine->packet_ready);
    pthread_mutex_unlock(&engine->mutex);
    return true;
}

static void publish_crop(struct engine *engine, const uint8_t *luma, const SBufferInfo *picture) {
    int frame_width = picture->UsrData.sSystemBuffer.iWidth;
    int frame_height = picture->UsrData.sSystemBuffer.iHeight;
    int stride = picture->UsrData.sSystemBuffer.iStride[0];
    if (!luma || frame_width < 120 || frame_height < 80 || frame_width > MAX_WIDTH ||
        frame_height > MAX_HEIGHT || stride < frame_width) return;
    pthread_mutex_lock(&engine->mutex);
    const struct region region = engine->region;
    int left = frame_width * region.x / 100;
    int top = frame_height * region.y / 100;
    int right = frame_width - frame_width * (100 - region.x - region.width) / 100;
    int bottom = frame_height - frame_height * (100 - region.y - region.height) / 100;
    int width = right - left;
    int height = bottom - top;
    for (int row = 0; row < height; row++)
        memcpy(engine->crop.pixels + row * width, luma + (top + row) * stride + left, (size_t)width);
    engine->crop.width = width;
    engine->crop.height = height;
    engine->crop.revision = region.revision;
    engine->has_crop = true;
    pthread_cond_signal(&engine->crop_ready);
    pthread_mutex_unlock(&engine->mutex);
}

static void *decode_packets(void *context) {
    struct engine *engine = context;
    uint64_t next_crop = 0;
    for (;;) {
        pthread_mutex_lock(&engine->mutex);
        while (!engine->count && !atomic_load(&engine->done))
            pthread_cond_wait(&engine->packet_ready, &engine->mutex);
        if (atomic_load(&engine->done)) {
            pthread_mutex_unlock(&engine->mutex);
            break;
        }
        struct packet packet = engine->packets[engine->head];
        engine->head = (engine->head + 1) % QUEUE_SIZE;
        engine->count--;
        pthread_mutex_unlock(&engine->mutex);

        uint8_t *planes[3] = { NULL, NULL, NULL };
        SBufferInfo picture = { 0 };
        (*engine->decoder)->DecodeFrameNoDelay(engine->decoder, packet.bytes, (int)packet.size, planes, &picture);
        free(packet.bytes);
        if (picture.iBufferStatus == 1 && milliseconds() >= next_crop) {
            publish_crop(engine, planes[0], &picture);
            next_crop = milliseconds() + 210;
        }
    }
    return NULL;
}

static bool same_text_mask(const uint8_t *mask, const uint8_t *previous, size_t size) {
    size_t changed = 0;
    for (size_t index = 0; index < size; index++) changed += mask[index] != previous[index];
    return changed <= size / 2500;
}

static void build_mask(const struct crop *crop, uint8_t *mask) {
    memset(mask, 255, (size_t)crop->width * (size_t)crop->height);
    for (int y = 2; y < crop->height - 2; y++) {
        for (int x = 2; x < crop->width - 2; x++) {
            int index = y * crop->width + x;
            const uint8_t *p = crop->pixels + index;
            if (*p < 172) continue;
            int shade = *p - 55;
            int step = crop->width * 2;
            if (p[-2] < shade || p[2] < shade || p[-step] < shade || p[step] < shade)
                mask[index] = 0;
        }
    }
}

static void report_ocr(const char *text, int confidence, int revision) {
    struct json_object *value = event("ocr");
    json_object_object_add(value, "text", json_object_new_string(text ? text : ""));
    json_object_object_add(value, "confidence", json_object_new_int(confidence));
    json_object_object_add(value, "revision", json_object_new_int(revision));
    emit(value);
}

static void *read_subtitles(void *context) {
    struct engine *engine = context;
    struct crop *crop = malloc(sizeof(*crop));
    uint8_t *mask = malloc(MAX_PIXELS);
    uint8_t *previous = malloc(MAX_PIXELS);
    if (!crop || !mask || !previous) {
        message("error", "TV altyazı okumak için yeterli bellek ayıramadı.");
        atomic_store(&engine->done, true);
    }
    size_t previous_size = 0;
    int previous_width = 0;
    int previous_revision = -1;
    char *text = NULL;
    int confidence = 0;
    while (!atomic_load(&engine->done)) {
        pthread_mutex_lock(&engine->mutex);
        while (!engine->has_crop && !atomic_load(&engine->done))
            pthread_cond_wait(&engine->crop_ready, &engine->mutex);
        if (atomic_load(&engine->done)) {
            pthread_mutex_unlock(&engine->mutex);
            break;
        }
        crop->width = engine->crop.width;
        crop->height = engine->crop.height;
        crop->revision = engine->crop.revision;
        size_t size = (size_t)crop->width * (size_t)crop->height;
        memcpy(crop->pixels, engine->crop.pixels, size);
        engine->has_crop = false;
        pthread_mutex_unlock(&engine->mutex);

        build_mask(crop, mask);
        if (previous_revision != crop->revision || previous_size != size || previous_width != crop->width ||
            !same_text_mask(mask, previous, size)) {
            memcpy(previous, mask, size);
            previous_size = size;
            previous_width = crop->width;
            previous_revision = crop->revision;
            if (text) TessDeleteText(text);
            TessBaseAPISetImage(engine->ocr, mask, crop->width, crop->height, 1, crop->width);
            TessBaseAPISetSourceResolution(engine->ocr, 150);
            text = TessBaseAPIGetUTF8Text(engine->ocr);
            confidence = text ? TessBaseAPIMeanTextConf(engine->ocr) : 0;
        }
        report_ocr(text, confidence, crop->revision);
    }
    if (text) TessDeleteText(text);
    free(previous);
    free(mask);
    free(crop);
    return NULL;
}

static void stream_event(ChiakiEvent *status, void *context) {
    struct engine *engine = context;
    if (status->type == CHIAKI_EVENT_CONNECTED) {
        emit(event("ready"));
    } else if (status->type == CHIAKI_EVENT_QUIT || status->type == CHIAKI_EVENT_LOGIN_PIN_REQUEST) {
        if (!atomic_load(&engine->done)) {
            const char *reason = status->type == CHIAKI_EVENT_QUIT
                ? chiaki_quit_reason_string(status->quit.reason)
                : "Önce ikinci hesabın PS5 oturum PIN’ini konsolda aç.";
            message("error", reason ? reason : "PS5 bağlantısı kesildi.");
        }
        atomic_store(&engine->done, true);
    }
}

static int stream_console(struct engine *engine, struct json_object *input, const char *address, const char *runtime) {
    engine->region = default_region;
    parse_region(input, &engine->region);
    ChiakiConnectInfo info = { .ps5 = true, .host = address, .enable_idr_on_fec_failure = true };
    if (!from_hex(field(input, "registKey"), (uint8_t *)info.regist_key, sizeof(info.regist_key)) ||
        !from_hex(field(input, "rpKey"), info.morning, sizeof(info.morning))) {
        message("error", "Kayıtlı PS5 eşleştirmesi geçersiz. Cihazı yeniden eşleştir.");
        return 1;
    }
    from_hex(field(input, "account"), info.psn_account_id, sizeof(info.psn_account_id));
    struct json_object *quality;
    int height = json_object_object_get_ex(input, "quality", &quality) ? json_object_get_int(quality) : 540;
    ChiakiVideoResolutionPreset resolution = height == 720
        ? CHIAKI_VIDEO_RESOLUTION_PRESET_720p : CHIAKI_VIDEO_RESOLUTION_PRESET_540p;
    chiaki_connect_video_profile_preset(&info.video_profile, resolution, CHIAKI_VIDEO_FPS_PRESET_30);
    info.video_profile.codec = CHIAKI_CODEC_H264;
    info.video_profile_auto_downgrade = true;
    info.packet_loss_max = 0.05;

    int result = 1;
    bool decoder_initialized = false;
    bool session_initialized = false;
    bool session_started = false;
    bool decoding = false;
    bool recognizing = false;
    pthread_t decoder_thread;
    pthread_t ocr_thread;
    SDecodingParam decoder_options = { 0 };
    char tessdata[PATH_MAX];
    snprintf(tessdata, sizeof(tessdata), "%s/tessdata", runtime);
    if (WelsCreateDecoder(&engine->decoder) != 0 || !engine->decoder ||
        (*engine->decoder)->Initialize(engine->decoder, &decoder_options) != 0) {
        message("error", "H.264 video çözücü başlatılamadı.");
        goto cleanup;
    }
    decoder_initialized = true;
    engine->ocr = TessBaseAPICreate();
    if (!engine->ocr || TessBaseAPIInit2(engine->ocr, tessdata, "eng", OEM_LSTM_ONLY) != 0) {
        message("error", "İngilizce altyazı tanıma verisi açılamadı.");
        goto cleanup;
    }
    TessBaseAPISetPageSegMode(engine->ocr, PSM_SINGLE_BLOCK);

    if (chiaki_session_init(&engine->session, &info, &engine->log) != CHIAKI_ERR_SUCCESS) {
        message("error", "PS5 Uzaktan Oynatma oturumu hazırlanamadı.");
        goto cleanup;
    }
    session_initialized = true;
    chiaki_session_set_event_cb(&engine->session, stream_event, engine);
    chiaki_session_set_video_sample_cb(&engine->session, video_packet, engine);
    decoding = pthread_create(&decoder_thread, NULL, decode_packets, engine) == 0;
    recognizing = decoding && pthread_create(&ocr_thread, NULL, read_subtitles, engine) == 0;
    if (!recognizing || chiaki_session_start(&engine->session) != CHIAKI_ERR_SUCCESS) {
        message("error", "PS5 altyazı akışı başlatılamadı.");
        goto cleanup;
    }
    session_started = true;
    while (!atomic_load(&engine->done) && receive_region_update(engine)) {}
    result = 0;

cleanup:
    pthread_mutex_lock(&engine->mutex);
    atomic_store(&engine->done, true);
    pthread_cond_broadcast(&engine->packet_ready);
    pthread_cond_broadcast(&engine->crop_ready);
    pthread_mutex_unlock(&engine->mutex);
    if (session_started) {
        chiaki_session_stop(&engine->session);
        chiaki_session_join(&engine->session);
    }
    if (decoding) pthread_join(decoder_thread, NULL);
    if (recognizing) pthread_join(ocr_thread, NULL);
    for (size_t index = 0; index < engine->count; index++)
        free(engine->packets[(engine->head + index) % QUEUE_SIZE].bytes);
    if (session_initialized) chiaki_session_fini(&engine->session);
    if (engine->ocr) TessBaseAPIDelete(engine->ocr);
    if (decoder_initialized) (*engine->decoder)->Uninitialize(engine->decoder);
    if (engine->decoder) WelsDestroyDecoder(engine->decoder);
    return result;
}

int main(int argc, char **argv) {
    if (argc != 2) return 1;
    setvbuf(stdin, NULL, _IONBF, 0);
    char line[4096];
    if (!fgets(line, sizeof(line), stdin)) return 1;
    struct json_object *input = json_tokener_parse(line);
    if (!input) return 1;
    const char *mode = field(input, "mode");
    const char *address = field(input, "address");
    struct in_addr ip;
    int result = 1;
    struct engine *engine = NULL;
    if (chiaki_lib_init() != CHIAKI_ERR_SUCCESS) {
        message("error", "Uzaktan Oynatma altyapısı başlatılamadı.");
        goto done;
    }
    if (strcmp(mode, "discover") == 0) {
        result = discover_consoles();
        goto done;
    }
    if (inet_pton(AF_INET, address, &ip) != 1) {
        message("error", "PS5 bağlantısı için geçerli bir IP adresi gerekli.");
        goto done;
    }
    engine = calloc(1, sizeof(*engine));
    if (!engine) {
        message("error", "TV altyazı motoru için yeterli bellek yok.");
        goto done;
    }
    chiaki_log_init(&engine->log, 0, NULL, NULL);
    atomic_init(&engine->done, false);
    atomic_init(&engine->registered, false);
    pthread_mutex_init(&engine->mutex, NULL);
    pthread_cond_init(&engine->packet_ready, NULL);
    pthread_cond_init(&engine->crop_ready, NULL);
    if (strcmp(mode, "pair") == 0) result = pair_console(engine, input, address);
    else if (strcmp(mode, "stream") == 0) result = stream_console(engine, input, address, argv[1]);
    pthread_cond_destroy(&engine->crop_ready);
    pthread_cond_destroy(&engine->packet_ready);
    pthread_mutex_destroy(&engine->mutex);

done:
    free(engine);
    json_object_put(input);
    return result;
}
