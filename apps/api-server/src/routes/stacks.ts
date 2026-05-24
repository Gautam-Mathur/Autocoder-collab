import { Router } from "express";

const router = Router();

router.get("/stacks", (_req, res) => {
  res.json({
    stacks: [
      {
        id: "react-vite-express",
        label: "React + Vite + Express",
        description: "TypeScript full-stack with Drizzle ORM + PostgreSQL",
        tags: ["default", "typescript"],
      },
      {
        id: "mern",
        label: "MERN Stack",
        description: "MongoDB + Express + React + Node",
        tags: ["mongodb", "nosql"],
      },
      {
        id: "django-react",
        label: "Django + React",
        description: "Python Django REST Framework + React Vite frontend",
        tags: ["python", "django"],
      },
      {
        id: "spring-boot-react",
        label: "Spring Boot + React",
        description: "Java Spring Boot 3 + JPA + PostgreSQL + React Vite",
        tags: ["java", "enterprise"],
      },
      {
        id: "dotnet-react",
        label: "ASP.NET Core + React",
        description: "C# ASP.NET Core 8 + Entity Framework + React Vite",
        tags: ["csharp", "dotnet", "enterprise"],
      },
      {
        id: "go-gin-react",
        label: "Go + Gin + React",
        description: "Go + Gin + GORM + PostgreSQL + React Vite",
        tags: ["go", "golang", "performance"],
      },
    ],
  });
});

export default router;
