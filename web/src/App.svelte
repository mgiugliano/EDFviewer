<script lang="ts">
</script>

<main>
  <h1>EDF Viewer</h1>
  <button disabled>Open EDF file</button>
</main>

<style>
  main {
    max-width: 800px;
    margin: 40px auto;
    padding: 0 20px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }

  button {
    padding: 8px 16px;
    font-size: 14px;
    cursor: pointer;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
</style>
