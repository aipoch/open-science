#include <stdio.h>
#include <stdlib.h>

// A native LaunchServices entry probe, not an updater or an alternate rescue product.
int main(void) {
  FILE *result = fopen(RECOVERY_ENTRY_RECEIPT, "w");
  if (!result) return 2;
  fputs("ordinary-entry-executed\n", result);
  fclose(result);
  return 0;
}
