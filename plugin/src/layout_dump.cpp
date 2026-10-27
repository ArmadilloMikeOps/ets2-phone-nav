// Друкує build/layout.json зі зсувами полів trucknav_shm_t для companion.
// Збирається під x86_64, як і плагін, щоб розкладка гарантовано збігалася.

#include <stddef.h>
#include <stdio.h>

#include "shm_layout.h"

static bool first = true;

static void field(const char *name, size_t offset, const char *type, int len)
{
	if (name[0] == '_') return;
	printf("%s\n    \"%s\": {\"offset\": %zu, \"type\": \"%s\", \"len\": %d}", first ? "" : ",", name, offset, type, len);
	first = false;
}

#define BODY_OFFSET(name) (offsetof(trucknav_shm_t, body) + offsetof(trucknav_body_t, name))
#define DUMP(ctype, name, jstype) field(#name, BODY_OFFSET(name), #jstype, 0);
#define DUMP_STR(name, len)       field(#name, BODY_OFFSET(name), "str", len);

int main()
{
	printf("{\n  \"magic\": %u,\n  \"version\": %u,\n  \"size\": %zu,\n", TRUCKNAV_MAGIC, TRUCKNAV_VERSION, sizeof(trucknav_shm_t));
	printf("  \"seq\": %zu,\n  \"seq_end\": %zu,\n  \"fields\": {", offsetof(trucknav_shm_t, seq), offsetof(trucknav_shm_t, seq_end));
	TRUCKNAV_FIELDS(DUMP, DUMP_STR)
	printf("\n  }\n}\n");
	return 0;
}
