tools = [
    {
        "type": "function",
        "function": {
            "name": "create_shape",
            "description": "Create a shape (circle, rectangle/square, triangle, or star)",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "enum": ["circle", "rectangle", "triangle", "star"],
                        "description": (
                            "The shape to create. 'rectangle' also covers squares "
                            "(a square is just a rectangle with equal width/height). "
                            "'triangle' is a simple equilateral-ish triangle. 'star' "
                            "is a 5-pointed star. Defaults to 'rectangle' (a square) if unclear."
                        ),
                    },
                    "color": {
                        "type": "string",
                        "description": (
                            "Shape color. Return a CSS color string. "
                            "Prefer 6-digit hex (#RRGGBB) for solid colors. "
                            "Use rgba() when transparency is specified. "
                            "Examples: '#ff0000', '#336699', "
                            "'rgba(255, 0, 0, 0.5)'. "
                            "Defaults to white if unclear — not required."
                        )
                    },
                    "size": {"type": "number"},
                },
                "required": [],
            },
        },
    }
]
