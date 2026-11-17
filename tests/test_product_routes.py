"""Public product HTML must not open API or look-alike paths."""
from leaseq.api import app
from leaseq.security import access


def test_canonical_pages_are_registered_and_public():
    registered = {route.path for route in app.routes if "GET" in getattr(route, "methods", ())}
    for path in ("/", "/overview", "/workbench", "/reports", "/settings"):
        assert path in registered
        assert access("GET", path, False) == "open"
        assert access("POST", path, False) == "token"


def test_product_pages_do_not_open_apis_or_unknown_children():
    for path in ("/overview/private", "/workbench.js", "/reports/data", "/settings.json",
                 "/jobs", "/jobs/1/events", "/workers", "/metrics", "/api/system"):
        assert access("GET", path, False) == "token"
