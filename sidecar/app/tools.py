tools = [
    {
        "type": "function",
        "function": {
            "name": "create_circle",
            "description": "Create a circle shape",
            "parameters": {
                "type": "object",
                "properties": {
                    "color": {
                        "type": "string",
                        "description": (
                            "Circle color. Return a CSS color string. "
                            "Prefer 6-digit hex (#RRGGBB) for solid colors. "
                            "Use rgba() when transparency is specified. "
                            "Examples: '#ff0000', '#336699', "
                            "'rgba(255, 0, 0, 0.5)'."
                        )
                    },
                    "size": {"type": "number"},
                },
                "required": [],
            },
        },
    }
]