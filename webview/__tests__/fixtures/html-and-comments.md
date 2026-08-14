# HTML and comments

<!-- editorial note: keep this section short -->

Normal paragraph with <sub>subscript</sub> and <kbd>Ctrl</kbd> inline HTML.

<div align="center">
  <img src="logo.png" width="200" alt="Logo">
</div>

<details>
<summary>Click to expand</summary>

Hidden *formatted* content.

</details>

Trailing paragraph.

<div style="text-align: center; color: teal">A style attribute whose declarations are kept.</div>

<div style="position: fixed; inset: 0; height: 100vh">A style attribute whose escaping declarations are dropped from the RENDERING only.</div>

<style>
.editor-topbar { display: none }
</style>

<p>A block whose <span style="z-index: 9">nested</span> style attribute is filtered too.</p>

<!--
multi-line comment
still going
-->
