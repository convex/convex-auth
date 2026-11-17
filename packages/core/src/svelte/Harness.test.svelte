<!--
  Runs `setup` during the initialization of a component that has the
  context of the Svelte bindings (unless `context` is undefined), as a
  component below `setupConvexAuth` would. For the tests of the method
  helpers.
-->
<script lang="ts">
  import {
    setConvexAuthContext,
    type ConvexAuthContext,
  } from "./client.svelte.ts";

  let {
    context,
    setup,
  }: { context: ConvexAuthContext | undefined; setup: () => void } = $props();

  // svelte-ignore state_referenced_locally
  if (context !== undefined) setConvexAuthContext(context);
  // svelte-ignore state_referenced_locally
  setup();
</script>
