#define _GNU_SOURCE
#define PAGU_DENIAL_SPIKE_TESTING
#include "denial-spike.c"

static void require(bool condition, const char *message) {
  if (!condition) {
    fprintf(stderr, "denial-spike-test: %s\n", message);
    exit(1);
  }
}

int main(void) {
  char *json = NULL;
  size_t size = 0;
  FILE *stream = open_memstream(&json, &size);
  require(stream != NULL, "open_memstream");
  require(
      write_record_at(stream, "openat", "/secret/quote\"\\\n",
                      "2026-07-22T10:11:12.345Z") == 0,
      "write record");
  require(fclose(stream) == 0, "close record stream");
  require(
      strcmp(json,
             "{\"syscall\":\"openat\",\"path\":"
             "\"/secret/quote\\\"\\\\\\n\",\"verdict\":\"deny\","
             "\"ts\":\"2026-07-22T10:11:12.345Z\"}\n") == 0,
      "exact structured denial record");
  free(json);

  require(strcmp(syscall_name(__NR_openat), "openat") == 0,
          "openat syscall name");
  require(path_is_denied("/home/user/.ssh/key", "/home/user/.ssh/key"),
          "exact path denied");
  require(!path_is_denied("/home/user/.ssh/key.pub", "/home/user/.ssh/key"),
          "prefix is not an exact denial");
  return 0;
}
