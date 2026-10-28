# Realizacje – Polskie Gry Planszowe

Strona z przykładami produktów (portfolio) dla klientów oraz panel administracyjny do zarządzania produktami, zdjęciami i kategoriami. Działa w całości na **GitHub Pages**, bez serwera i bez opłat.

```
index.html            – strona dla klientów
assets/               – wygląd (CSS) i działanie (JS) strony
data/products.json    – produkty i kategorie (edytowane przez panel)
images/produkty/      – zdjęcia w dużej rozdzielczości (max 1800 px)
images/thumbs/        – miniatury (max 700 px)
images/brand/         – logo i ikony
admin/                – panel administracyjny
```

## 1. Publikacja na GitHub (jednorazowo)

1. Załóż konto na <https://github.com> (jeśli go nie masz).
2. Utwórz nowe repozytorium: **New repository**, nazwa np. `realizacje`, widoczność **Public**. Nie zaznaczaj „Add a README”.
3. W terminalu, w tym katalogu:

   ```bash
   git init -b main
   git add .
   git commit -m "Strona z realizacjami"
   git remote add origin https://github.com/TWOJ-LOGIN/realizacje.git
   git push -u origin main
   ```

4. W repozytorium na GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, gałąź `main`, folder `/ (root)`, **Save**.
5. Po 1–2 minutach strona będzie pod adresem `https://TWOJ-LOGIN.github.io/realizacje/`.

> Folder `pojedyncze/` (oryginalne zdjęcia, ~50 MB) jest pominięty w `.gitignore`. Na stronie są ich zoptymalizowane kopie z `images/`.

### Własna domena (opcjonalnie)

Jeśli chcesz adres typu `realizacje.polskiegryplanszowe.pl`: w **Settings → Pages → Custom domain** wpisz domenę, a u operatora domeny dodaj rekord **CNAME** `realizacje` → `TWOJ-LOGIN.github.io`.

## 2. Panel administracyjny

Adres: `https://TWOJ-LOGIN.github.io/realizacje/admin/`

Przy pierwszym wejściu panel poprosi o połączenie z GitHub (zakładka **Połączenie z GitHub**). Potrzebny jest token:

1. <https://github.com/settings/personal-access-tokens/new>
2. **Repository access → Only select repositories** → wybierz `realizacje`.
3. **Permissions → Repository permissions → Contents: Read and write**.
4. **Generate token**, skopiuj i wklej w panelu.

Token zapisuje się tylko w Twojej przeglądarce. Bez niego nikt nie może niczego zmienić, nawet jeśli zna adres panelu.

### Co można robić w panelu

- **Produkty**: dodawanie, edycja nazwy i opisu, tagi, zmiana kolejności (↑ ↓), ukrywanie (szkic), wyróżnianie (trafiają na górę strony).
- **Zdjęcia**: wgrywanie (przeciągnij i upuść), zmiana kolejności, wybór okładki, usuwanie. Zdjęcia są automatycznie zmniejszane w przeglądarce, więc możesz wgrywać pliki prosto z aparatu.
- **Kategorie**: dodawanie, zmiana nazwy, kolejność, usuwanie. Produkt może należeć do kilku kategorii.
- **Przypisywanie hurtowe**: zaznacz kilka produktów na liście i dodaj je do kategorii lub z niej usuń.

Zmiany zbierają się lokalnie. Przycisk **Opublikuj zmiany** wysyła wszystko jednym zapisem na GitHub, a strona odświeża się po ok. 1–2 minutach.

## Podgląd lokalny

```bash
python3 -m http.server 8765
```

Potem otwórz <http://localhost:8765>. Panel (`/admin/`) bez tokenu działa w trybie podglądu: możesz edytować, ale zapis wymaga połączenia z GitHub. Przycisk **Eksportuj JSON** pozwala pobrać plik z danymi.
