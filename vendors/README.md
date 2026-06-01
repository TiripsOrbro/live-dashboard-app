# Vendor catalog files

Live dotfiles in this folder are **tracked in git** (store 3811 catalogs). After clone/pull they are ready to use; `vendors/examples/` remains the template source.

| File | Vendor |
|------|--------|
| `.Americold` | Americold |
| `.Bega` | Bega |
| `.CutFresh` | Cut Fresh |
| `.Schweppes` | Schweppes |
| `.item-codes` | MMX ↔ order-form code map |

See [VENDOR-FORMAT.md](./VENDOR-FORMAT.md) for the line format (`10 | itemCode | name | …`).

Recreate from examples:

```powershell
Copy-Item vendors\examples\.Schweppes.example vendors\.Schweppes
Copy-Item vendors\examples\.Americold.example vendors\.Americold
Copy-Item vendors\examples\.Bega.example vendors\.Bega
Copy-Item vendors\examples\.CutFresh.example vendors\.CutFresh
Copy-Item vendors\examples\.item-codes.example vendors\.item-codes
```
