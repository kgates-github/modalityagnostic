from .components import COMPONENT_KINDS

_type_description = "The component to create. " + " ".join(
    f"'{k.name}': {k.description}" for k in COMPONENT_KINDS
)

tools = [
    {
        "type": "function",
        "function": {
            "name": "create_component",
            "description": "Create a visual component (circle, rectangle/square, triangle, star, bar chart, ...)",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": [k.name for k in COMPONENT_KINDS],
                        "description": _type_description,
                    },
                    "color": {
                        "type": "string",
                        "description": (
                            "Component color. Return a CSS color string. "
                            "Prefer 6-digit hex (#RRGGBB) for solid colors. "
                            "Use rgba() when transparency is specified. "
                            "Examples: '#ff0000', '#336699', "
                            "'rgba(255, 0, 0, 0.5)'. "
                            # "default" below is a JSON Schema hint for validators,
                            # not an instruction a tool-calling model reads -- the
                            # model has to be told directly not to invent a color
                            # (measured: left to its own judgment, it does anyway
                            # about 1 in 10 tries). The real gray fallback is
                            # applied client-side when this is left out.
                            "If the user did not mention a color, omit this "
                            "parameter entirely -- never guess or invent one."
                        ),
                        "default": "#808080"
                    },
                    "size": {"type": "number"},
                },
                "required": [],
            },
        },
    }
]
