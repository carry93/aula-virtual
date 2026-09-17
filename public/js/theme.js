// ==========================================================================
// COMPUCLASE.CLICK - CONTROLADOR DE TEMA (SOLCITO Y LUNITA)
// ==========================================================================

(function() {
    // Obtener tema inicial
    function getStoredTheme() {
        return localStorage.getItem('theme') || 'dark';
    }

    // Aplicar tema
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-bs-theme', theme);
        const buttons = document.querySelectorAll('.theme-toggle-btn');
        buttons.forEach(btn => {
            const isDark = theme === 'dark';
            btn.setAttribute('title', isDark ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro');
            btn.setAttribute('aria-label', isDark ? 'Cambiar a Modo Claro' : 'Cambiar a Modo Oscuro');
        });
    }

    // Alternar tema
    window.toggleTheme = function() {
        const currentTheme = document.documentElement.getAttribute('data-bs-theme') || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        try {
            localStorage.setItem('theme', newTheme);
        } catch(e) {}
        applyTheme(newTheme);
    };

    // Ejecución inicial inmediata
    applyTheme(getStoredTheme());

    // Sincronizar al cargar el DOM completo
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            applyTheme(getStoredTheme());
        });
    } else {
        applyTheme(getStoredTheme());
    }
})();
