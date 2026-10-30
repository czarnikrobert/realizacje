# Realizacje – Polskie Gry Planszowe

Strona z przykładami produktów (portfolio) dla klientów oraz panel administracyjny do zarządzania produktami, zdjęciami i kategoriami. Działa w całości na **GitHub Pages**, bez serwera i bez opłat.

```
index.html            – strona dla klientów
assets/               – wygląd (CSS) i działanie (JS) strony
data/products.json    – produkty i kategorie (edytowane przez panel)
images/produkty/      – zdjęcia w dużej rozdzielczości (max 1800 px)
images/thumbs/        – miniatury (max 700 px)
images/brand/         – logo, ikony i obrazek podglądu linku (og-image.jpg, 1200×630)
robots.txt, sitemap.xml – dla wyszukiwarek (panel /admin/ wyłączony z indeksowania)
admin/                – panel administracyjny
```

## 1. Publikacja

- Strona: **<https://pgprealizacje.pl>** (także `www.pgprealizacje.pl`)
- Repozytorium: <https://github.com/czarnikrobert/realizacje>, gałąź `main`, publikowana przez GitHub Pages (Settings → Pages, źródło: `main`, folder `/`).
- Stary adres `czarnikrobert.github.io/realizacje` przekierowuje na domenę.

> Folder `pojedyncze/` (oryginalne zdjęcia, ~50 MB) jest pominięty w `.gitignore`. Na stronie są ich zoptymalizowane kopie z `images/`.

### Domena pgprealizacje.pl

Domena jest zarejestrowana w home.pl. Plik `CNAME` w repozytorium mówi GitHub Pages, pod jaką domeną ma działać strona. Strefa DNS w panelu home.pl:

| Typ | Nazwa | Wartość |
|---|---|---|
| A | @ | `185.199.108.153` |
| A | @ | `185.199.109.153` |
| A | @ | `185.199.110.153` |
| A | @ | `185.199.111.153` |
| CNAME | www | `czarnikrobert.github.io.` |

Kłódkę HTTPS włącza się w **Settings → Pages → Enforce HTTPS**, gdy GitHub wystawi certyfikat.

## 2. Panel administracyjny

Adres: `https://pgprealizacje.pl/admin/`

Panel jest chroniony hasłem. Przy pierwszym wejściu poprosi o token GitHub i o ustalenie hasła:

1. <https://github.com/settings/personal-access-tokens/new>
2. **Repository access → Only select repositories** → wybierz `realizacje`.
3. **Permissions → Repository permissions → Contents: Read and write**.
4. **Generate token**, skopiuj i wklej w panelu, a potem wymyśl hasło (min. 10 znaków).

Panel szyfruje token Twoim hasłem (AES-256-GCM, klucz z PBKDF2-SHA256, 600 000 iteracji) i zapisuje go w repozytorium jako `admin/auth.json`. Od tej pory na każdym komputerze logujesz się samym hasłem. Bez hasła tokenu nie da się odczytać, a bez tokenu nie da się nic zmienić. Plik jest jednak publiczny, dlatego hasło powinno być długie i niepowtarzalne.

Zakładka **Konto i hasło** pozwala zmienić hasło, wpisać nowy token (np. gdy stary wygaśnie) i się wylogować. Zalogowanie trwa do zamknięcia karty przeglądarki.

**Zapomniane hasło:** usuń plik `admin/auth.json` w repozytorium na GitHub (Add file → … → Delete file), utwórz nowy token, a panel poprosi o ponowną konfigurację.

> Panel zapisuje `admin/auth.json` i `data/products.json` bezpośrednio na GitHub. Zanim wyślesz zmiany z tego komputera przez `git push`, najpierw pobierz je poleceniem `git pull`.

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
